# FluxAgent

Modular, provider-independent AI agent runtime — a real agent brain: goal →
plan → tools → observation → verification → recovery → completion. Windows is
the primary development platform today; the agent brain, tools, HTTP API, SDK,
memory, skills, MCP, and evaluation layers are platform-independent.

No dependencies are installed by design. Node 22+ (native TypeScript
execution) and Python 3.11+ (stdlib worker) are the only requirements.

## Design principles

```
LLM            = decision maker (replaceable provider)
Agent runtime  = orchestrator (agent loop)
Tools          = controlled capabilities (registry + schemas)
Controllers    = OS interaction (files, command, process, window, screen, input, apps, system, network)
Memory         = session + persistent knowledge (vector-ready interfaces)
Observer       = environment feedback (structured observations + verification)
Permissions    = safety boundary (READ_ONLY < SAFE_WRITE < USER_CONFIRMATION < PRIVILEGED)
Events         = live activity stream (for the future desktop UI)
```

The LLM never touches the OS. It proposes plans/decisions; the runtime
validates them against the tool registry, enforces permissions, runs
controllers, observes results, and recovers from failures.

## Agent loop

```
USER GOAL
  ↓ UNDERSTAND          (ReasoningEngine → LlmProvider.plan)
  ↓ CREATE PLAN         (Planner → typed Plan: steps + dependencies)
  ↓ SELECT NEXT ACTION  (Executor picks next runnable step)
  ↓ CHECK PERMISSION    (PermissionManager: ceiling → auto-approve → approval UI)
  ↓ EXECUTE TOOL        (ToolRegistry: validate → execute → structured result)
  ↓ OBSERVE RESULT      (Observer → Observation in state + memory)
  ↓ UPDATE STATE        (StateManager: step status, tool calls, errors)
  ↓ VERIFY              (Observer.verify heuristics + tool-specific verifiers)
  ↓ RECOVER IF NEEDED   (RecoveryManager: retry w/ backoff → replan → abort)
  ↓ CONTINUE OR FINISH
```

## Usage

```ts
import { createRuntime, MockLlmProvider } from "fluxagent";

const runtime = createRuntime({
  provider: new MockLlmProvider({ /* scripted plan/decisions for tests */ }),
});

const session = runtime.createSession({ goal: "Organize my downloads folder" });
const result = await session.agent.run("Organize my downloads folder");
console.log(result.summary);

// Live activity (future desktop UI subscribes here):
runtime.recorder.events.forEach((e) => console.log(e.type));
```

Run tests (no network, no API keys):

```
npm test
```

## Real model providers (BYOK) — implemented

`src/llm/providers/` ships production BYOK adapters with **zero npm
dependencies** (raw `node:http`/`node:https`):

| Provider | Module | Notes |
|---|---|---|
| OpenAI-compatible | `providers/openai-compatible.ts` | Works with OpenAI, Azure-style gateways, OpenRouter, vLLM, LM Studio — any `/chat/completions` API. Streaming + tool calling + usage. |
| Anthropic | `providers/anthropic.ts` | `/v1/messages` with `tool_use`/`tool_result` content blocks. Streaming + tool calling. |
| Local | `providers/local.ts` | Ollama-style local servers; no API key required. |

```ts
import { OpenAiCompatibleProvider } from "./src/llm/providers/openai-compatible.ts";

const provider = new OpenAiCompatibleProvider({
  id: "openai-main",
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,   // key is never logged, never in errors
  defaultModel: "gpt-4o",
  timeoutMs: 30_000,
});
const runtime = createRuntime({ provider });
```

Provider errors are normalized into FluxAgent codes (`E_LLM_AUTH_FAILED`,
`E_LLM_RATE_LIMITED` with retry-after, `E_LLM_TIMEOUT`, `E_LLM_NETWORK`,
`E_LLM_CONTENT_POLICY`, …) with useful metadata and **no secret material**.

## Native tool calling — implemented

`src/agent/tool-calling.ts` drives the real model tool-use loop:

```
LLM → tool call → parse → schema validation → permission check →
ToolRegistry.execute → structured result (size-capped) → observation → next turn
```

- Tool schemas derive from the registry (`toolInfos()`), so the model only
  sees real tools with real JSON-schema argument contracts.
- Unknown tools, malformed arguments, permission denials, and tool failures
  become **structured tool results fed back to the model** — never thrown
  away, never faked, never executed.
- Turn budgets (`maxTurns`) and per-result size caps (`maxToolResultChars`)
  prevent runaway loops and context flooding.

## Computer use — implemented (backend-injected)

`src/computer/computer.ts` composes the controllers into one capability
facade. `ComputerController.capabilities()` reports honestly what is usable:

- `filesystem`, `command`, `system` — fully available (sandbox-enforced).
- `screen`, `input` — interface complete, backend pending (Python bridge or
  native addon). Calls return structured `E_PLATFORM_UNSUPPORTED` errors.
- `applications` — Windows today; other platforms get a capability error.

## Persistent semantic memory — implemented

`src/memory/semantic.ts` adds the memory pipeline over the layered store:

```
candidate → importance → deduplication (token overlap) → storage →
retrieval (relevance × importance × usage) → context feed
```

- Kinds: facts, preferences, project knowledge, experiences, procedures.
- Provenance is mandatory. Model-generated claims can never be stored as
  `fact` — they are downgraded automatically.
- `JsonFileSemanticStore` persists across restarts (`.fluxagent/memory/`).
- Optional expiry; expired records never reach the context.

## Permission grants & approvals — implemented

`PermissionManager` now supports an explicit grant model on top of approvals:

- `grant(tool, "once" | "session" | "tool", level, { expiresAt })` —
  allow-once, allow-for-session (optionally time-boxed), always-allow.
- `revoke(tool?)`, `activeGrants()`, and a bounded **audit trail**
  (`auditTrail()`) recording every decision with the reason
  (ceiling / auto-approve / grant / user / expired).
- Grants never beat the session ceiling; the model has no path to elevation.
- After a session resume, grants are **not** restored — sensitive actions
  re-ask.

## Skills — implemented

`src/skills/skill.ts` defines reusable capabilities: required tools, model
instructions, constraints, and an optional verification spec.

- `SkillRegistry.selectForGoal(goal)` picks the best skill by keyword match;
  skills whose required tools are missing report `missingTools` instead of
  failing mid-run.
- JSON skill files load from a directory (`loadSkillsFromDir`); invalid
  files are reported, never fatal.
- Built-ins: `coding`, `debugging`, `file-management`, `research`.
- Skills guide the planner; they never bypass the registry or permissions.

## Sessions: pause & resume — implemented

`src/runtime/resume.ts` builds on checkpoints for crash-safe resumability:

- `pause(sessionId, reason, state)` — user, approval-waiting, crash-recovery,
  or resource-limit pauses are checkpointed.
- `resume(checkpointId)` is **fail-closed**: corrupted shapes, missing fields,
  version mismatches, and cross-session restores all throw structured
  `E_CHECKPOINT_CORRUPT` errors — no partial restores.
- CLI: `fluxagent sessions` lists checkpoints; `fluxagent resume <id>`.

## MCP support — implemented (stdio)

`src/mcp/mcp.ts` is a JSON-RPC 2.0 MCP client over stdio:

- Connect/disconnect lifecycle, `initialize` handshake, `tools/list`
  discovery, `tools/call` execution with timeouts.
- Discovered tools register as **namespaced FluxAgent tools**
  (`mcp.<server>.<tool>`) at `USER_CONFIRMATION` level — external code always
  asks. MCP rides the same registry → permission → observation pipeline as
  native tools; there is no bypass.
- Server exits and protocol errors surface as structured
  `E_MCP_DISCONNECT` errors.

## Evaluation playground — implemented

`tests/eval/playground.test.ts` + `src/eval/evaluation.ts` provide the
case-runner and aggregate reporting:

- Scenarios: read, write, tool-failure recovery, permission denial,
  multi-step dependency chains — all through the real tool loop.
- `reportFrom()` aggregates pass rate, per-category averages, tool-call and
  model-call counts; `compareReports()` flags regressions against a baseline.
- Deterministic: scripted providers only, no network, no keys.

## HTTP API additions

Alongside the Phase 8 routes, the API now exposes:

```
GET /api/v1/providers          provider identities (never key material)
GET /api/v1/skills             skills + readiness + missing tools
GET /api/v1/memory/semantic    memory stats + search (?q=…)
GET /api/v1/permissions/:sid   ceiling, active grants, audit trail
```

## CLI

```
fluxagent run "<goal>"      Run one goal (mock provider; deterministic, offline)
fluxagent doctor [--json]   Health diagnostics
fluxagent tools             List registered tools
fluxagent models            List routed model descriptors
fluxagent providers [--json]  List providers (no secrets)
fluxagent skills [--json]   List skills and readiness
fluxagent sessions [--json] List saved checkpoints
fluxagent resume <id>       Resume from a checkpoint (grants are NOT restored)
fluxagent config [file]     Show redacted effective configuration
fluxagent version           Core/API/plugin versions
```

## Layout

```
src/
  agent/       brain: agent loop, planner, executor, observer, state, recovery,
               decision engine, observation engine, verification, diagnosis,
               recovery engine, self-evaluation + learning, context manager,
               subagents
  controllers/ OS layer: files, command, process, window, screen, keyboard,
               mouse, application, system, network
  tools/       registry, tool contract, schemas, permissions, discovery,
               builtin tools
  memory/      short-term, long-term (JSON file), conversation, vector-ready,
               layered memory (working/episodic/semantic/procedural + provenance)
  planning/    plan/step/task/dependency primitives, adaptive planning,
               task manager (priorities, deadlines, dependencies)
  llm/         provider interface, messages, responses, model router, mock
  events/      typed event bus + event union
  security/    permission manager, approval interfaces, sandbox policy
  runtime/     config, session, runtime composition, checkpoints, trace
  python/      Python bridge client + tools
python/        stdlib-only worker: vision, ocr, embeddings, documents
tests/         agent, tools, controllers, planning, memory, security, events
config/        default.json
```

## Brain expansion (phases 3–5)

Beyond the core loop, the brain adds a full reasoning pipeline:

| Subsystem | Module | What it does |
|---|---|---|
| Adaptive planning | `planning/adaptive.ts` | progress tracking, plan validity, downstream invalidation, expected outcomes + alternatives per step |
| Decision engine | `agent/decision.ts` | structured Decision (action, reason, expectedOutcome, confidence, risk, requiredPermission) between plan and execution |
| Observation engine | `agent/observation-engine.ts` | enriches observations with stateChanges, sideEffects, evidence; never assumes a tool "probably worked" |
| Verification engine | `agent/verification.ts` | result rules → state predicates → goal criteria; tool success ≠ task success |
| Error diagnosis | `agent/diagnosis.ts` | classify → diagnose → recommend (validation/permission/timeout/network/tool/environment/state/dependency/cancelled) |
| Recovery engine | `agent/recovery-engine.ts` | strategy selection from diagnosis, retry policies, recovery history, bounded by design |
| Checkpoints | `runtime/checkpoint.ts` | pause/resume/recover with versioned state; in-memory + JSON-file stores behind `CheckpointStore` |
| Context manager | `agent/context-manager.ts` | priority-tiered assembly under a char budget; compaction with digests, never blind truncation; critical constraints always kept |
| Layered memory | `memory/layers.ts` | working/episodic/semantic/procedural + provenance (user/tool/model/file/system) and epistemic type (fact/observation/assumption/model-generated) |
| Tool discovery | `tools/discovery.ts` | capability/category/risk/availability profiles; exposes only fitting tools per model call |
| Subagents | `agent/subagent.ts` | scoped tool sets, permission ceiling clamped below parent, timeouts, cancellation, structured result contract |
| Model router | `llm/router.ts` | provider-independent selection by purpose, complexity, capabilities, cost, context size |
| Self-evaluation | `agent/evaluation.ts` | post-run evaluation with explicit epistemics — opinions with evidence, never auto-promoted to fact; ExecutionLearner captures lessons as structured memory (no self-modifying code) |
| Task manager | `planning/task-manager.ts` | multi-task queue: priority, deadline, dependencies, blocking reasons, enforced state machine |
| Traceability | `runtime/trace.ts` | causal chains: task → decision → tool → observation → verification → recovery; "why did the agent do this?" answerable from data |

All of these are wired into the runtime session (`runtime.createSession()`) and
exercise-able without network access.

### Phase 6 — advanced intelligence, learning & model routing

| Subsystem | Module | What it does |
|---|---|---|
| Task analysis | `agent/task-analysis.ts` | goal → type, complexity, reasoning level, capability needs — feeds strategy + routing |
| Confidence system | `agent/confidence.ts` | per-decision/tool/verification confidence as *metadata* (basis, origin) — never treated as truth |
| Advanced decision engine | `agent/decision-advanced.ts` | strategy selection (fast/balanced/deep/conservative) from analysis + failure history, wraps and preserves the base heuristic engine |
| Execution ledger | `agent/execution-ledger.ts` | structured tool/model/strategy/recovery outcome records → reliability stats feed routing & decisions; adaptive strategy ladder on repeated failure |

### Phase 7 — task orchestration & reliability

| Subsystem | Module | What it does |
|---|---|---|
| Reliability layer | `runtime/reliability.ts` | retry with exponential backoff + jitter, timeout enforcement, circuit breaker (closed/open/half-open), graceful fallback, composable `executeReliably` |
| Priority queue | `runtime/task-orchestrator.ts` | background→critical ranking with deadline boost |
| Task orchestrator | `runtime/task-orchestrator.ts` | dependency graphs (cycle detection), parallel execution with concurrency caps, per-task timeout, cancellation, failure isolation, checkpoint/pause/resume for long-running tasks |

### Phase 8 — universal API & model gateway

| Subsystem | Module | What it does |
|---|---|---|
| Model gateway | `api/gateway.ts` | capability-detected provider dispatch (chat/stream/embed/vision/tool-use) behind one interface; reliability-wrapped |
| HTTP API | `api/http-server.ts` | versioned endpoints: `/api/v1/agent/run`, `/agent/stream` (SSE), `/tasks`, `/sessions`, `/tools`, `/models`, `/events`, `/health` |
| Auth | `api/auth.ts` | API-key + local authenticators, scoped tokens, hashed keys, secret providers (env/in-memory/composite) — never plaintext storage |
| API spec | `api/spec.ts` | machine-readable route spec + OpenAPI export for clients |

### Phase 9 — SDK & client ecosystem

| Subsystem | Module | What it does |
|---|---|---|
| TypeScript SDK | `sdk/client.ts` | `FluxAgentClient`: run/stream/tasks/sessions/tools/models/health, typed errors, auto API-key auth |
| Streaming client | `sdk/client.ts` | SSE consumption with reconnect + exponential backoff, typed event handlers (`client.on("tool.started", …)`) |

### Phase 10 — security, audit & input hardening

| Subsystem | Module | What it does |
|---|---|---|
| Audit log | `security/audit.ts` | structured, retention-bounded records of permission grants/denials, tool/process/security events — no sensitive values recorded |
| Untrusted-input validation | `security/audit.ts` | depth/size/keys limits, prototype-pollution guard; model output and manifests treated as hostile input |
| Plugin manifest validation | `security/audit.ts` | strict shape + semver + API-version compatibility |

### Phase 11 — evaluation, benchmarking & diagnostics

| Subsystem | Module | What it does |
|---|---|---|
| Evaluation framework | `eval/evaluation.ts` | run goals under pluggable checks (completed, tools-used, duration, recovery); metrics per case |
| Benchmark suite | `eval/evaluation.ts` | built-in planning/tool-usage/multi-step/recovery cases on the mock provider; category reports + regression comparison |
| Diagnostics | `eval/evaluation.ts` | structured run explanations (plan summary, tools called, decisions, failure category, timeline) — no chain-of-thought exposure |

### Phase 12 — plugin ecosystem

| Subsystem | Module | What it does |
|---|---|---|
| Plugin manager | `plugins/plugin-manager.ts` | discover → validate → load → initialize → enable → disable → unload lifecycle; manifest validation; API-version compatibility |
| Plugin permissions | `plugins/plugin-manager.ts` | contributed tools go through the same registry with permission levels **clamped to the ceiling**; namespaced `plugin.<name>.<tool>` |
| Plugin storage | `plugins/plugin-manager.ts` | namespaced storage seam per plugin |

### Phase 13 — production runtime

| Subsystem | Module | What it does |
|---|---|---|
| Cache | `runtime/observability.ts` | TTL+LRU cache with single-flight dedupe; refuses secret-like keys unless policy explicitly allows |
| Resource limits | `runtime/observability.ts` | concurrent tasks, queue depth, model/tool calls per minute, heap guard — acquire/release with structured rejection |
| Metrics + health | `runtime/observability.ts` | counters/gauges/histograms (p95), health registry with throwing-check safety |
| Storage abstraction | `runtime/observability.ts` | `KeyValueStorage` with in-memory + JSON-file backends; databases plug in later |
| Environments | `runtime/environments.ts` | development/test/production presets; startup validation (production: auth required, no auto-approve, explicit roots, no debug logging) |

All of these are wired into the runtime session (`runtime.createSession()`) and
exercise-able without network access.

## Dependencies — intentionally not installed

Per project rules, nothing is installed. All new Phase 1–9 subsystems were
built **dependency-free** (raw `node:http`/`node:https`, `node:child_process`,
JSON files). Remaining seams:

| Capability | Future dependency | Status |
|---|---|---|
| Screenshot capture | Python `mss`/`Pillow` via bridge, or native addon | `ScreenController` + backend seam; typed errors, no fakes |
| Keyboard/mouse input | Python ctypes `SendInput`, or `@nut-tree/nut-js` | Backend seams; typed errors, no fakes |
| OCR | Python `pytesseract` | worker module interface ready |
| PDF/DOCX parsing | Python `PyMuPDF` / `python-docx` | worker module interface ready |
| Semantic embeddings | Python `sentence-transformers` | token-overlap retrieval provided (no vectors needed to start) |
| Full JSON Schema | `ajv` (optional) | dependency-free subset implemented |
| Vector memory | sqlite-vec / Qdrant / etc. | `VectorMemory` interface ready |

Every unavailable capability reports a structured, actionable error — the
runtime never fakes results.

## Security model

- Four ordered permission levels; every tool declares one.
- Session ceiling + auto-approve band + interactive approvals (UI seam ready).
- Explicit grants (once/session/tool, expiry) with audit trail; ceiling is
  absolute — grants never bypass it and the model cannot self-elevate.
- Filesystem sandbox with allowed/denied roots (Windows-drive aware);
  path-traversal payloads are rejected.
- Command policy blocklist; argument-array spawning (no shell string).
- Destructive tools (`file.delete`, `process.terminate`, `app.close`) require
  `USER_CONFIRMATION`/`PRIVILEGED`.
- Secrets are redacted in logs; env access is masked by default; provider
  errors never contain API keys.
- Model output is untrusted: every tool call is schema-validated and
  permission-checked; injected instructions in tool output gain nothing.
- MCP tools are external code by definition — always `USER_CONFIRMATION`.
