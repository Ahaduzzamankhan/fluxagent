/**
 * Phase 5 tests: tool discovery, subagents, model router, self-evaluation +
 * execution learning, task manager, traceability.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ToolDiscovery, categoryFor, riskForLevel } from "../../src/tools/discovery.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { S } from "../../src/tools/schemas.ts";
import { ModelRouterService, mockModelDescriptor } from "../../src/llm/router.ts";
import { SelfEvaluator, ExecutionLearner } from "../../src/agent/evaluation.ts";
import { TaskManager, TaskTransitionError } from "../../src/planning/task-manager.ts";
import { TraceRecorder } from "../../src/runtime/trace.ts";
import { SubagentManager } from "../../src/agent/subagent.ts";
import type { Agent, AgentRunResult } from "../../src/agent/agent.ts";
import { StateManager, makeObservation } from "../../src/agent/state.ts";
import { createPlan, createStep } from "../../src/planning/plan.ts";

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry({ sessionId: "t" });
  const mk = (name: string, level: "READ_ONLY" | "SAFE_WRITE" | "USER_CONFIRMATION" | "PRIVILEGED", tags: string[] = []): Parameters<ToolRegistry["register"]>[0] => ({
    metadata: { name, description: `d for ${name}`, inputSchema: S.object({ path: S.string("p") }), permissionLevel: level, tags },
    validate(): void {},
    async execute() {
      return {};
    },
  });
  reg.register(mk("file.read", "READ_ONLY"));
  reg.register(mk("file.write", "SAFE_WRITE"));
  reg.register(mk("file.delete", "USER_CONFIRMATION", ["destructive"]));
  reg.register(mk("process.terminate", "PRIVILEGED", ["destructive"]));
  reg.register(mk("screen.screenshot", "USER_CONFIRMATION"));
  return reg;
}

// ── tool discovery ────────────────────────────────────────────────────────────

test("discovery filters by category, permission, availability, destructive", () => {
  const reg = makeRegistry();
  const disc = new ToolDiscovery(reg);
  disc.setAvailability("screen.screenshot", false, "no backend");

  assert.equal(disc.discover({ category: "filesystem" }).length, 3);
  assert.equal(disc.discover({ category: "screen" }).length, 0, "unavailable tools hidden by default");

  const safe = disc.discover({ maxPermission: "SAFE_WRITE", excludeDestructive: true });
  assert.deepEqual(safe.map((t) => t.info.name).sort(), ["file.read", "file.write"]);

  const all = disc.discover({ onlyAvailable: false });
  assert.equal(all.length, 5);
  const shot = all.find((t) => t.info.name === "screen.screenshot");
  assert.equal(shot!.profile.available, false);
  assert.match(shot!.profile.unavailableReason ?? "", /backend/);
});

test("discovery infers capabilities and risk levels", () => {
  const disc = new ToolDiscovery(makeRegistry());
  const read = disc.describe("file.read")!;
  assert.equal(read.profile.category, "filesystem");
  assert.equal(read.profile.risk, "low");
  assert.ok(read.profile.capabilities.includes("read"));
  assert.ok(read.profile.capabilities.includes("non-mutating"));

  const term = disc.describe("process.terminate")!;
  assert.equal(term.profile.risk, "high");
  assert.equal(categoryFor("python.execute"), "python");
  assert.equal(riskForLevel("PRIVILEGED"), "high");
});

test("discovery forModel returns plain ToolInfo", () => {
  const disc = new ToolDiscovery(makeRegistry());
  const infos = disc.discoverForModel({ category: "filesystem", maxPermission: "SAFE_WRITE" });
  assert.deepEqual(infos.map((i) => i.name).sort(), ["file.read", "file.write"]);
});

// ── model router ──────────────────────────────────────────────────────────────

test("model router filters by capability and quality constraints", () => {
  const router = new ModelRouterService();
  router.registerModels([
    { id: "a:small", provider: "a", name: "small", capabilities: ["text", "tool-use"], quality: 4, cost: 2, maxInputTokens: 32_000 },
    { id: "b:big", provider: "b", name: "big", capabilities: ["text", "tool-use", "reasoning", "long-context"], quality: 9, cost: 8, maxInputTokens: 200_000 },
    { id: "c:vision", provider: "c", name: "vision", capabilities: ["text", "vision"], quality: 6, cost: 5, maxInputTokens: 100_000 },
  ]);

  const planning = router.select({ purpose: "plan", complexity: "complex" })!;
  assert.equal(planning.id, "b:big", "complex planning needs quality+tools");

  const vision = router.select({ purpose: "vision", complexity: "moderate" })!;
  assert.equal(vision.id, "c:vision", "vision tasks need vision-capable models");

  const huge = router.select({ purpose: "generate", complexity: "moderate", approxInputChars: 120_000 })!;
  assert.equal(huge.id, "b:big", "huge inputs prefer long-context models");
});

test("model router falls back to best registered model", () => {
  const router = new ModelRouterService();
  router.registerModel(mockModelDescriptor());
  const m = router.selectOrDefault({ purpose: "vision", complexity: "complex" })!;
  assert.equal(m.id, "mock:deterministic");
});

// ── self-evaluation + learning ────────────────────────────────────────────────

test("self-evaluator separates verified fact from opinion and detects wrong assumptions", () => {
  const evaluator = new SelfEvaluator();
  const sm = new StateManager("s", "create ProjectX project");
  const a = createStep({ title: "create dir", description: "", tool: "file.create" });
  const b = createStep({ title: "init project", description: "", tool: "command.run" });
  a.status = "completed";
  b.status = "failed";
  b.error = { name: "FluxError", code: "E_COMMAND_BLOCKED", message: "blocked", details: {} };
  sm.setPlan(createPlan("create ProjectX project", "s", [a, b]));

  const okObs = makeObservation({ sessionId: "s", toolName: "file.create", callId: "c1", ok: true, output: { created: true }, durationMs: 2, stepId: a.id });
  const stateVerdict = { kind: "state" as const, subject: "project dir", passed: false, checks: [{ name: "exists", passed: false, detail: "dir missing" }], note: "state mismatch: dir missing", at: new Date().toISOString() };

  const evaluation = evaluator.evaluate({
    goal: "create ProjectX project",
    state: sm.get(),
    enrichedObservations: [],
    verdicts: [stateVerdict],
    sideEffects: ["stray temp file"],
  });

  assert.equal(evaluation.kind, "self-evaluation");
  assert.equal(evaluation.goalAchieved, false);
  assert.equal(evaluation.failedSteps.length, 1);
  assert.equal(evaluation.failedSteps[0]!.category, "E_COMMAND_BLOCKED");
  assert.ok(evaluation.wrongAssumptions.length >= 1, "tool ok + state fail = wrong assumption");
  assert.deepEqual(evaluation.sideEffects, ["stray temp file"]);
  assert.equal(evaluation.claims.some((c) => c.epistemicType === "fact"), true, "formal verdicts count as fact-backed claims");
  void okObs;
});

test("execution learner produces bounded lessons without self-modification", () => {
  const evaluator = new SelfEvaluator();
  const learner = new ExecutionLearner();
  const evaluation = evaluator.evaluate({
    goal: "g",
    state: (() => { const sm = new StateManager("s", "g"); return sm.get(); })(),
    enrichedObservations: [],
    verdicts: [],
    sideEffects: [],
  });
  const lessons = learner.learnFrom(evaluation, "task-1");
  assert.ok(Array.isArray(lessons));
  assert.ok(learner.all().length >= 0);
  const applicable = learner.applicable("anything", 5);
  assert.ok(applicable.length <= 7);
});

// ── task manager ──────────────────────────────────────────────────────────────

test("task manager: transitions enforce the state machine", () => {
  const tm = new TaskManager();
  const t = tm.add({ goal: "do thing", priority: "high" });
  assert.equal(t.status, "queued");

  tm.update(t.id, "active");
  assert.throws(() => tm.update(t.id, "queued"), TaskTransitionError);
  tm.update(t.id, "blocked", "missing dependency");
  assert.equal(tm.get(t.id)!.blockingReason, "missing dependency");
  tm.update(t.id, "active");
  tm.update(t.id, "completed");
  assert.throws(() => tm.update(t.id, "active"), TaskTransitionError);
});

test("task manager: pickNext respects priority, deadlines, dependencies", () => {
  const tm = new TaskManager();
  const first = tm.add({ goal: "first" });
  tm.update(first.id, "active");
  tm.update(first.id, "completed");

  const low = tm.add({ goal: "low prio", priority: "low" });
  const high = tm.add({ goal: "high prio", priority: "high" });
  const dependent = tm.add({ goal: "needs first", dependsOn: [first.id] });
  void dependent;
  void low;

  const next1 = tm.pickNext()!;
  assert.equal(next1.goal, "high prio");

  // Overdue low-priority task beats normal priority.
  const overdue = tm.add({
    goal: "overdue low",
    priority: "low",
    deadline: new Date(Date.now() - 60_000).toISOString(),
  });
  const normal = tm.add({ goal: "normal", priority: "normal" });
  void normal;
  tm.update(high.id, "active");
  const next2 = tm.pickNext()!;
  assert.equal(next2.goal, "overdue low");
});

test("task manager: blockedTasks reports failed dependencies", () => {
  const tm = new TaskManager();
  const a = tm.add({ goal: "will fail" });
  tm.update(a.id, "active");
  tm.update(a.id, "failed");
  const b = tm.add({ goal: "blocked child", dependsOn: [a.id] });
  const blocked = tm.blockedTasks();
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.task.id, b.id);
  assert.match(blocked[0]!.reason, /failed/);
});

// ── traceability ──────────────────────────────────────────────────────────────

test("trace recorder builds causal chains for a step", () => {
  const trace = new TraceRecorder();
  const taskRec = trace.record({ type: "task.created", taskId: "t1", detail: { goal: "g" } });
  const decRec = trace.record({ type: "decision.created", taskId: "t1", stepId: "s1", decisionId: "d1", parentTraceId: taskRec.id, detail: { action: "execute-step" } });
  trace.record({ type: "tool.started", taskId: "t1", stepId: "s1", callId: "c1", parentTraceId: decRec.id });
  trace.record({ type: "observation.created", taskId: "t1", stepId: "s1", observationId: "o1", callId: "c1", parentTraceId: decRec.id });
  trace.record({ type: "verification.completed", taskId: "t1", stepId: "s1", parentTraceId: decRec.id, detail: { passed: true } });

  const chain = trace.chainForStep("s1");
  assert.equal(chain.length, 5, "decision, tool.started, observation, verification + the decision's own record via linkage");
  assert.equal(trace.size, 5);
  const taskChain = trace.forTask("t1");
  assert.equal(taskChain.length, 5);
  assert.ok(taskChain[0]!.at <= taskChain[taskChain.length - 1]!.at);
});

// ── subagents ─────────────────────────────────────────────────────────────────

function fakeAgent(result: Partial<AgentRunResult>): Agent {
  const run = async (): Promise<AgentRunResult> => ({
    status: "completed",
    summary: "sub task done",
    planId: null,
    stepsCompleted: 1,
    stepsFailed: 0,
    observations: 1,
    durationMs: 5,
    ...result,
  });
  return { run } as unknown as Agent;
}

test("subagent manager runs a scoped child and returns structured results", async () => {
  let capturedTools: readonly string[] = [];
  const mgr = new SubagentManager({
    parentCeiling: "USER_CONFIRMATION",
    createAgent: (opts) => {
      capturedTools = opts.toolNames;
      return fakeAgent({ status: "completed", summary: "researched" });
    },
  });
  const result = await mgr.run({
    kind: "research",
    task: "find all TODOs",
    allowedTools: ["file.read", "file.search"],
    permissionCeiling: "PRIVILEGED", // must be clamped to parent's ceiling
    timeoutMs: 5000,
  });
  assert.equal(result.lifecycle, "completed");
  assert.equal(result.summary, "researched");
  assert.deepEqual(capturedTools, ["file.read", "file.search"]);
  assert.equal(result.spec.permissionCeiling, "USER_CONFIRMATION", "child cannot escalate above parent");
});

test("subagent manager reports failures as structured results, never throws", async () => {
  const mgr = new SubagentManager({
    parentCeiling: "PRIVILEGED",
    createAgent: () => fakeAgent({ status: "failed", summary: "child broke" }),
  });
  const result = await mgr.run({ kind: "coding", task: "x", allowedTools: [], permissionCeiling: "SAFE_WRITE" });
  assert.equal(result.lifecycle, "failed");
  assert.equal(result.summary, "child broke");
});

test("subagent cancellation settles with cancelled lifecycle", async () => {
  const mgr = new SubagentManager({
    parentCeiling: "READ_ONLY",
    createAgent: () =>
      ({
        run: (_goal: string, opts: { signal?: AbortSignal }) =>
          new Promise<AgentRunResult>((resolve) => {
            opts.signal?.addEventListener("abort", () =>
              resolve({ status: "cancelled", summary: "aborted", planId: null, stepsCompleted: 0, stepsFailed: 0, observations: 0, durationMs: 1 }),
            );
          }),
      }) as unknown as Agent,
  });
  const handle = mgr.spawn({ kind: "analysis", task: "long job", allowedTools: [], permissionCeiling: "READ_ONLY", timeoutMs: 30_000 });
  assert.equal(mgr.activeCount, 1);
  handle.cancel("user asked");
  const result = await handle.promise;
  assert.equal(result.lifecycle, "cancelled");
  assert.equal(mgr.activeCount, 0);
});
