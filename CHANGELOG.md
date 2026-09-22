# Changelog

All notable changes to FluxAgent are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-09-22

### Added
- **Platform layer** (`src/platform/platform.ts`): centralized platform
  detection, per-OS sandbox defaults (Windows drives, POSIX critical
  directories), platform-aware path canonicalization, shell/temp-dir facts.
  The process controller now supports POSIX (`ps`/`kill`) alongside Windows
  (`tasklist`/`taskkill`).
- **Error standardization**: stable `ErrorCategory` mapping for every error
  code, retryability metadata, and `publicErrorJSON()` — a stack-trace-free
  serialization for APIs/SDKs (details opt-in only).
- **Logging polish**: `fatal` level, correlation bindings via
  `logger.withBindings({ requestId, traceId, … })` (still redacted), `jsonSink()`
  and `fileSink()` factories.
- **Config migrations** (`src/runtime/migrations.ts`): versioned, idempotent
  migrations applied inside `loadConfig` — v0 nested
  `memory.longTerm.directory` config files keep loading; obsolete keys are
  dropped with a report.
- **Doctor diagnostics** (`src/runtime/doctor.ts`): PASS/WARN/FAIL/SKIP checks
  over node, config+migrations, sandbox, runtime/tools/models, storage,
  memory directory, python, and permission mode — machine-readable
  (`DoctorReport`), human-formatted, secret-free.
- **CLI** (`src/cli/index.ts`, `bin/fluxagent.mjs`): `version`, `doctor
  [--json]`, `tools`, `models`, `config`, `run "<goal>"`, `help` — thin over
  the public runtime API, no duplicated logic.
- **Performance regression tests** (`tests/runtime/perf.test.ts`): bounded
  budgets for startup, agent run, registry/discovery scale, routing,
  memory, cache, and storage throughput.
- **CI** (`.github/workflows/ci.yml`): typecheck, full test suite, perf
  budgets, python syntax checks, and doctor smoke on Windows/Linux/macOS ×
  Node 22/24; tag-gated release verification (version match + tests; publish
  stays manual).
- **Open-source files**: MIT `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `docs/` (architecture, migration
  guide, data handling).

### Changed
- `config/default.json` is now platform-neutral; denied roots and blocked
  command tokens come from the platform layer at load time.
- Sandbox `DEFAULT_SANDBOX_POLICY` derives from the host platform instead of
  hard-coded Windows paths.
- `loadConfig` runs migrations transparently before validation.

## [0.1.0] — 2026-09-22

### Added
- Core agent runtime: goal → plan → execute → observe → verify → recover loop
  with structured state, event bus, and checkpoints.
- Tool system: typed registry, JSON-schema validation, permission levels
  (`READ_ONLY`, `SAFE_WRITE`, `USER_CONFIRMATION`, `PRIVILEGED`) with approval
  requester seam.
- Controllers: files, command, process, window, keyboard, mouse, screen,
  application, system, network — OS interaction isolated from the brain.
- Memory: short-term, conversation, long-term (in-memory + JSON-file),
  layered memory with provenance and epistemic types.
- LLM abstraction: provider interface, message/response types, model router
  service, deterministic mock provider for offline testing.
- Advanced brain: adaptive planning, decision engine, observation and
  verification engines, error diagnosis, strategy-based recovery engine,
  context manager, subagents, self-evaluation, execution learning.
- Orchestration: task manager, dependency graphs, priority queue, parallel
  execution with concurrency limits, reliability layer (retry/backoff,
  circuit breaker, fallback).
- Universal API: versioned HTTP endpoints, SSE streaming, API-key auth with
  hashed secrets, machine-readable API spec + OpenAPI export.
- SDK: `FluxAgentClient` with typed events, streaming client with reconnect.
- Security: sandbox (path + command policy), audit log, untrusted-input
  validation, plugin manifest validation.
- Plugins: manifest lifecycle (discover → validate → enable → disable →
  unload), permission clamping, namespaced tools.
- Evaluation: benchmark suite, regression comparison, chain-of-thought-free
  diagnostics, trace recorder wired into every session.
- Python bridge: JSON-over-stdio worker with vision/ocr/embeddings/documents
  modules (stdlib-only; optional extras reported as capability errors).
- Observability: TTL/LRU cache, resource limiter, metrics registry, health
  checks, storage abstraction (in-memory + JSON-file), environment presets
  with production startup validation.
