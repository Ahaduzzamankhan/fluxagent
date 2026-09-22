# FluxAgent

Windows-first modular AI agent runtime — a real agent brain: goal → plan →
tools → observation → verification → recovery → completion.

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
  // real providers plug into the same LlmProvider interface (todo: adapters)
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

Per project rules, nothing is installed yet. Seams are ready:

| Capability | Future dependency | Status |
|---|---|---|
| Real LLM providers | `openai` / `@anthropic-ai/sdk` (or raw `node:https`) | `LlmProvider` interface + mock ready |
| Screenshot capture | Python `mss`/`Pillow` via bridge, or native addon | `ScreenController` + backend seam; typed errors, no fakes |
| Keyboard/mouse input | Python ctypes `SendInput`, or `@nut-tree/nut-js` | Backend seams; typed errors, no fakes |
| OCR | Python `pytesseract` | worker module interface ready |
| PDF/DOCX parsing | Python `PyMuPDF` / `python-docx` | worker module interface ready |
| Semantic embeddings | Python `sentence-transformers` | hash fallback provided for plumbing |
| Full JSON Schema | `ajv` (optional) | dependency-free subset implemented |
| Vector memory | sqlite-vec / Qdrant / etc. | `VectorMemory` interface ready |

Every unavailable capability reports a structured, actionable error — the
runtime never fakes results.

## Security model

- Four ordered permission levels; every tool declares one.
- Session ceiling + auto-approve band + interactive approvals (UI seam ready).
- Filesystem sandbox with allowed/denied roots (Windows-drive aware).
- Command policy blocklist; argument-array spawning (no shell string).
- Destructive tools (`file.delete`, `process.terminate`, `app.close`) require
  `USER_CONFIRMATION`/`PRIVILEGED`.
- Secrets are redacted in logs; env access is masked by default.
