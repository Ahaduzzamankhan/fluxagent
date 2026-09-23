# FluxAgent

An AI agent runtime for Node.js. You give it a goal, it plans, uses tools on your computer (read/write files, run commands), checks its own work, and reports the result.

**Why it exists:** an LLM alone can't do anything — it can only output text. FluxAgent connects an LLM to real tools while keeping control in the runtime, not the model. The model proposes actions; FluxAgent decides whether they're allowed, executes them, and verifies the results.

**What it is NOT:** it is not a chatbot, not a hosted service, and not an npm library yet (it runs from source).

---

## How it works

Every goal runs through the same loop:

```
GOAL
 ↓ understand          LLM reads the goal, produces a plan
 ↓ check permission    runtime decides if the action is allowed
 ↓ execute tool        runtime runs the tool (the model never runs anything itself)
 ↓ observe result      runtime captures what actually happened
 ↓ verify              runtime checks the result is real, not just "exit code 0"
 ↓ recover or repeat   on failure: retry, replan, or stop honestly
 ↓ finish              report with evidence
```

The core rule: **the model thinks, the runtime controls.** The model can only pick tools from a registry and pass validated arguments. It cannot touch the filesystem, spawn processes, or grant itself permissions.

```
LLM
 ↓ proposes a tool call
ToolRegistry        validates the tool exists and args match the schema
 ↓
PermissionManager   enforces READ_ONLY < SAFE_WRITE < USER_CONFIRMATION < PRIVILEGED
 ↓
Controller          does the actual OS work (files, commands, processes)
 ↓
Observer            captures the real result
```

---

## What it's for

- **Coding tasks:** "find the TypeScript error, fix it, run the tests, tell me what changed"
- **File work:** organizing, renaming, searching, summarizing files inside a sandbox
- **Safe automation:** any task where you want the LLM to act but with a permission wall between it and your system
- **Building agent products:** the HTTP API + SDK + event stream let you build your own UI on top

---

## Requirements

- Node.js 22.6+ (uses native TypeScript execution — no build step)
- Python 3.11+ (optional, only for the Python worker features)
- Zero npm dependencies. Nothing to install except Node itself.

---

## Quick start

```bash
git clone https://github.com/Ahaduzzamankhan/fluxagent.git
cd fluxagent

# no npm install needed — zero dependencies

node --experimental-strip-types src/cli/index.ts doctor    # health check
node --experimental-strip-types src/cli/index.ts tools     # list available tools
node --experimental-strip-types src/cli/index.ts run "read the file package.json and summarize it"
```

`run` uses the built-in mock provider by default (deterministic, offline, no key needed). To use a real LLM:

```ts
import { createRuntime } from "./src/runtime/runtime.ts";
import { OpenAiCompatibleProvider } from "./src/llm/providers/openai-compatible.ts";

const provider = new OpenAiCompatibleProvider({
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: "gpt-4o",
});

const runtime = createRuntime({ provider });
const session = runtime.createSession({ goal: "fix the failing test" });
const result = await session.agent.run("fix the failing test");
console.log(result.summary);
```

Works with any OpenAI-compatible API (OpenAI, OpenRouter, vLLM, LM Studio), Anthropic, or a local Ollama server. Your API key is read from the environment, never logged, and never included in errors.

---

## What's inside

```
src/
  agent/       brain: planning, execution, observation, verification, recovery,
               tool-calling loop, decisions, context, subagents
  controllers/ OS layer: files, command, process, window, screen, keyboard,
               mouse, application, system, network
  computer/    high-level computer-use facade over the controllers
  tools/       tool registry, schemas, permissions, built-in tools
  llm/         provider interface, BYOK providers, model router
  memory/      session memory, layered memory, persistent semantic memory
  skills/      reusable skill definitions (coding, debugging, research, ...)
  security/    permission manager, grants, approvals, sandbox
  mcp/         MCP client (connect external tool servers over stdio)
  runtime/     runtime composition, config, checkpoints, pause/resume
  api/         HTTP API + SSE streaming + auth
  sdk/         TypeScript client for the HTTP API
  eval/        evaluation and benchmark framework
  plugins/     plugin lifecycle and isolation
python/        optional stdlib-only Python worker
tests/         279 tests, all offline and deterministic
```

### Main features

| Feature | Status | Where |
|---|---|---|
| Plan → execute → verify → recover agent loop | working | `src/agent/` |
| BYOK providers (OpenAI-compatible, Anthropic, local) | working | `src/llm/providers/` |
| Native tool calling with schema validation | working | `src/agent/tool-calling.ts` |
| File / command / process tools (sandboxed) | working | `src/tools/builtin/` |
| Permission levels + grants + audit trail | working | `src/security/` |
| Persistent semantic memory with dedup | working | `src/memory/semantic.ts` |
| Skills | working | `src/skills/` |
| Pause / resume / crash recovery | working | `src/runtime/resume.ts` |
| MCP tool servers (stdio) | working | `src/mcp/` |
| HTTP API + SSE + SDK | working | `src/api/`, `src/sdk/` |
| Evaluation framework | working | `src/eval/` |
| Computer use (screen capture, keyboard/mouse) | needs backend | `src/computer/` |
| Application control | Windows only | `src/controllers/application.ts` |

### Not done yet (honest list)

- Screen capture and keyboard/mouse injection — the interfaces exist, the OS backends (Python bridge or native addon) are not written. Calls return a clear "unsupported" error instead of faking results.
- Application control off Windows.
- No packaging/publishing yet (not on npm).

---

## HTTP API

Start the server in code with `createApiServer(...)`. Endpoints (all versioned under `/api/v1`):

```
GET  /health                  server status
POST /agent/run               run a goal { "goal": "..." }
GET  /agent/stream            live SSE event stream
GET  /tools                   registered tools
GET  /models                  available models
GET  /providers               providers (no key material)
GET  /skills                  skills + readiness
GET  /sessions, /sessions/:id session state
GET  /tasks, /tasks/:id       task orchestration state
GET  /events                  recent events
GET  /memory/semantic?q=...   semantic memory search
GET  /permissions/:sessionId   grants + audit trail
```

---

## Security model

- **Permission levels:** every tool declares `READ_ONLY`, `SAFE_WRITE`, `USER_CONFIRMATION`, or `PRIVILEGED`. A session ceiling caps everything; the model cannot raise it.
- **Grants:** users can allow a tool once, for a session, or always — with optional expiry. Every decision is audited.
- **Sandbox:** file tools only operate inside allowed roots; path traversal is rejected. Commands run through a blocklist, spawned without a shell.
- **Untrusted model output:** every tool call is schema-validated and permission-checked. Injection text inside tool results gains nothing.
- **Secrets:** API keys live in the environment, are redacted from logs, and never appear in errors or events.
- **MCP tools are external code** — they always require confirmation.

---

## Development

```bash
npm test                          # 279 tests, offline, no API keys
node --experimental-strip-types src/cli/index.ts doctor
```

Run a single test file:

```bash
node --experimental-strip-types --test tests/agent/tool-calling.test.ts
```

Tests use scripted providers, mock HTTP servers on localhost, and temp directories. No test touches the network or needs a key.

---

## License

MIT — see [LICENSE](LICENSE).
