/**
 * Phase 4 tests: recovery engine strategies/limits/history, checkpoint
 * pause/resume, context budgeting/compaction, layered memory + provenance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { RecoveryEngine } from "../../src/agent/recovery-engine.ts";
import { CheckpointManager, InMemoryCheckpointStore, JsonFileCheckpointStore } from "../../src/runtime/checkpoint.ts";
import { ContextManager, renderContext, compactObservations, DEFAULT_BUDGET } from "../../src/agent/context-manager.ts";
import { LayeredMemory, InMemoryLayeredStore, provenance, procedureFromSteps } from "../../src/memory/layers.ts";
import { StateManager, makeObservation, createAgentState } from "../../src/agent/state.ts";
import { createPlan, createStep } from "../../src/planning/plan.ts";
import { serializeState } from "../../src/agent/state.ts";

function failObs(tool: string, code: string, message: string, stepId = "s1") {
  return makeObservation({
    sessionId: "s", toolName: tool, callId: "c", ok: false,
    error: { name: "FluxError", code: code as never, message, details: {} },
    durationMs: 5, stepId,
  });
}
function step() {
  return createStep({ title: "flaky", description: "", tool: "file.write" });
}

// ── recovery engine ───────────────────────────────────────────────────────────

test("recovery engine: timeout retries with backoff up to the limit", () => {
  const engine = new RecoveryEngine({ maxRetriesPerStep: 2, retryBaseDelayMs: 100 });
  const s = step();

  const r1 = engine.recover(s, failObs("command.run", "E_STEP_TIMEOUT", "timeout"));
  assert.equal(r1.action, "retry");
  assert.equal(r1.delayMs, 100);
  assert.equal(r1.strategy.name, "retry-with-backoff");

  const r2 = engine.recover(s, failObs("command.run", "E_STEP_TIMEOUT", "timeout"));
  assert.equal(r2.action, "retry");
  assert.equal(r2.delayMs, 200);

  const r3 = engine.recover(s, failObs("command.run", "E_STEP_TIMEOUT", "timeout"));
  assert.equal(r3.action, "replan", "retry limit must force replan, never loop");
});

test("recovery engine: permission problems route to approval, not retry", () => {
  const engine = new RecoveryEngine();
  const r = engine.recover(step(), failObs("command.run", "E_PERMISSION_DENIED", "nope"));
  assert.equal(r.action, "request-approval");
  assert.equal(r.strategy.consumesRetry, false);
});

test("recovery engine: invalid args → alternative-tool path (repair)", () => {
  const engine = new RecoveryEngine();
  const r = engine.recover(step(), failObs("file.write", "E_TOOL_ARGUMENTS_INVALID", "bad"));
  assert.equal(r.action, "alternative-tool");
});

test("recovery engine keeps bounded history and resets per-step budgets", () => {
  const engine = new RecoveryEngine({ maxRetriesPerStep: 1 });
  const s = step();
  engine.recover(s, failObs("command.run", "E_STEP_TIMEOUT", "t1"));
  engine.resetStep(s.id);
  const r = engine.recover(s, failObs("command.run", "E_STEP_TIMEOUT", "t2"));
  assert.equal(r.action, "retry", "reset must restore the retry budget");
  assert.ok(engine.totalAttempts >= 2);
  assert.ok(engine.getRecoveryHistory(1).length === 1);
});

// ── checkpoints ───────────────────────────────────────────────────────────────

test("checkpoint manager saves and resumes from in-memory store", async () => {
  const store = new InMemoryCheckpointStore();
  const mgr = new CheckpointManager({ store });
  const sm = new StateManager("sess-cp", "goal");
  sm.setGoal("mid-run goal");
  sm.incrementStepCount();

  const cp = await mgr.create({ sessionId: "sess-cp", label: "before risky step", state: sm.get(), retryBudgets: { s1: 1 } });
  assert.equal(cp.version, 1);

  const resumed = await mgr.resume(cp.id);
  assert.ok(resumed);
  assert.equal(resumed!.state.goal, "mid-run goal");
  assert.equal(resumed!.retryBudgets["s1"], 1);

  const latest = await mgr.latestFor("sess-cp");
  assert.equal(latest?.id, cp.id);
  void createAgentState;
});

test("json file checkpoint store persists and lists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flux-cp-"));
  const store = new JsonFileCheckpointStore(dir);
  const mgr = new CheckpointManager({ store });
  const state = createAgentState("sess-fs", "file goal");

  const cp = await mgr.create({ sessionId: "sess-fs", label: "snap", state });
  const files = await readdir(dir);
  assert.ok(files.length >= 1);

  const loaded = await store.load(cp.id);
  assert.equal(loaded?.state.goal, "file goal");
  const listed = await store.list("sess-fs");
  assert.equal(listed.length, 1);
  await store.delete(cp.id);
  assert.equal((await store.load(cp.id)), undefined);
});

test("checkpoint state is serializable JSON", async () => {
  const store = new InMemoryCheckpointStore();
  const mgr = new CheckpointManager({ store });
  const sm = new StateManager("sess-j", "g");
  const plan = createPlan("g", "s", [createStep({ title: "t", description: "", tool: null })]);
  sm.setPlan(plan);
  const cp = await mgr.create({ sessionId: "sess-j", label: "x", state: sm.get() });
  const json = serializeState(cp.state);
  assert.ok(JSON.parse(json).plan);
});

// ── context manager ───────────────────────────────────────────────────────────

test("context manager assembles prioritized sections and renders", () => {
  const cm = new ContextManager();
  const state = createAgentState("s", "build the thing");
  state.errors.push({ name: "X", code: "E_INTERNAL", message: "stale process handle", details: {} });
  const ctx = cm.assemble({
    systemPrompt: "You are FluxAgent.",
    state,
    conversation: [{ role: "user", content: "please build", at: new Date().toISOString() }],
    memoryFacts: ["project uses pnpm"],
    tools: [{ name: "file.read", description: "read", inputSchema: { type: "object" }, permissionLevel: "READ_ONLY", tags: [] }],
    unresolvedProblems: ["port 3000 already in use"],
  });
  const text = renderContext(ctx);
  assert.match(text, /## SYSTEM/);
  assert.match(text, /GOAL: build the thing/);
  assert.match(text, /UNRESOLVED: port 3000/);
  assert.match(text, /MEMORY: project uses pnpm/);
  assert.match(text, /AVAILABLE TOOLS/);
});

test("context manager keeps critical content under tiny budgets, drops the rest", () => {
  const cm = new ContextManager({ budget: { maxChars: 300 } });
  const state = createAgentState("s", "critical goal");
  const bigObservations = Array.from({ length: 50 }, (_, i) =>
    makeObservation({ sessionId: "s", toolName: `tool.${i}`, callId: `c${i}`, ok: true, output: { blob: "x".repeat(400) }, durationMs: 1 }),
  );
  state.observations.push(...bigObservations);
  const ctx = cm.assemble({
    systemPrompt: "sys",
    state,
    conversation: Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `turn ${i} ${"y".repeat(200)}`, at: new Date().toISOString() })),
    memoryFacts: [],
    tools: [],
  });
  assert.ok(ctx.totalChars <= 320, `total ${ctx.totalChars} must respect budget`);
  assert.ok(ctx.compacted, "overshoot must be reported as compaction");
  const text = renderContext(ctx);
  assert.match(text, /critical goal/, "task is critical and survives");
  assert.match(text, /digest of/, "old observations become a digest instead of vanishing");
});

test("compactObservations keeps recent verbatim and digests older failures", () => {
  const obs = [
    ...Array.from({ length: 10 }, (_, i) => failObs(`t${i}`, "E_INTERNAL", `fail ${i}`, `s${i}`)),
    makeObservation({ sessionId: "s", toolName: "file.read", callId: "c", ok: true, output: { ok: 1 }, durationMs: 1 }),
  ];
  const items = compactObservations(obs, 3);
  assert.ok(items.length >= 3);
  assert.match(items[0]!.text, /digest of 8 older observations/);
  assert.match(items[0]!.text, /notable failures/);
});

test("DEFAULT_BUDGET caps are sane fractions", () => {
  assert.ok(DEFAULT_BUDGET.maxChars > 1000);
  assert.ok((DEFAULT_BUDGET.sectionCaps?.observations ?? 0) <= 1);
});

// ── layered memory + provenance ───────────────────────────────────────────────

test("layered memory: layers, provenance, search, forget, trim", async () => {
  const mem = new LayeredMemory({ store: new InMemoryLayeredStore({ maxPerLayer: 3 }) });

  await mem.rememberFact({ content: "user prefers pnpm", provenance: provenance("user", "user-provided", "chat"), importance: 0.9, tags: ["tooling"] });
  await mem.rememberFact({ content: "model thinks pnpm is faster", provenance: provenance("model", "model-generated", "mock", 0.4), importance: 0.3 });
  await mem.recordEpisode({ summary: "ran file.write on config.json", importance: 0.5 });
  await mem.rememberProcedure({ description: "verify file exists after write", tags: ["verify"] });

  const all = await mem.search({});
  assert.equal(all.length, 4);

  const factsOnly = await mem.verifiedFacts(10);
  assert.equal(factsOnly.length, 1, "model-generated content must not count as verified fact");
  assert.equal(factsOnly[0]!.content, "user prefers pnpm");

  const tagged = await mem.search({ tags: ["tooling"] });
  assert.equal(tagged.length, 1);

  const first = all[0]!;
  await mem.forget(first.id);
  assert.equal((await mem.search({ query: first.content })).length, 0);
});

test("layered memory trims per-layer to maxPerLayer", async () => {
  const mem = new LayeredMemory({ store: new InMemoryLayeredStore({ maxPerLayer: 2 }) });
  for (let i = 0; i < 5; i++) {
    await mem.recordEpisode({ summary: `episode ${i}`, importance: i / 10 });
  }
  const remaining = await mem.search({ layers: ["episodic"] });
  assert.equal(remaining.length, 2, "low-importance episodes are trimmed first");
});

test("working memory is scratch-state and procedural capture works", async () => {
  const mem = new LayeredMemory();
  mem.setWorking("currentFile", "src/index.ts");
  assert.equal(mem.getWorking("currentFile"), "src/index.ts");
  assert.deepEqual(mem.workingKeys(), ["currentFile"]);
  mem.clearWorking();
  assert.equal(mem.workingKeys().length, 0);

  await mem.rememberProcedure({
    description: procedureFromSteps([
      { title: "write", tool: "file.write" },
      { title: "verify", tool: "file.exists" },
    ]),
  });
  const procs = await mem.search({ layers: ["procedural"] });
  assert.match(procs[0]!.content, /write \[file\.write\] → verify \[file\.exists\]/);
});
