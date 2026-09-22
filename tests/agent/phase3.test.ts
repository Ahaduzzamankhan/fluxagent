/**
 * Phase 3 tests: adaptive planning, decision engine, diagnosis, verification,
 * observation engine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { planProgress, evaluatePlanValidity, invalidateDownstream, progressSummary, createAdaptiveStep } from "../../src/planning/adaptive.ts";
import { createPlan, createStep } from "../../src/planning/plan.ts";
import { HeuristicDecisionEngine } from "../../src/agent/decision.ts";
import { diagnose, categorize, isPermissionProblem } from "../../src/agent/diagnosis.ts";
import { verifyResult, verifyState, verifyGoal, defaultCompletionCriteria, resultRules } from "../../src/agent/verification.ts";
import { ObservationEngine } from "../../src/agent/observation-engine.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { makeObservation } from "../../src/agent/state.ts";
import { S } from "../../src/tools/schemas.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function obsOk(tool: string, output: unknown, stepId?: string) {
  return makeObservation({ sessionId: "s", toolName: tool, callId: "c", ok: true, output, durationMs: 5, ...(stepId ? { stepId } : {}) });
}
function obsFail(tool: string, code: string, message: string, stepId?: string) {
  return makeObservation({
    sessionId: "s", toolName: tool, callId: "c", ok: false,
    error: { name: "FluxError", code: code as never, message, details: {} },
    durationMs: 5, ...(stepId ? { stepId } : {}),
  });
}
function registryWithTool(name: string, level: "READ_ONLY" | "SAFE_WRITE" | "USER_CONFIRMATION" | "PRIVILEGED" = "READ_ONLY") {
  const reg = new ToolRegistry({ sessionId: "t" });
  reg.register({
    metadata: { name, description: "d", inputSchema: S.object({}), permissionLevel: level, tags: [] },
    validate(): void {},
    async execute() {
      return {};
    },
  });
  return reg;
}

// ── adaptive planning ─────────────────────────────────────────────────────────

test("planProgress computes percent and stuck steps", () => {
  const a = createStep({ title: "a", description: "", tool: null });
  const b = createStep({ title: "b", description: "", tool: null });
  const c = createStep({ title: "c", description: "", tool: null });
  a.status = "completed";
  b.status = "failed";
  const plan = createPlan("g", "s", [a, b, c]);
  const p = planProgress(plan);
  assert.equal(p.total, 3);
  assert.equal(p.completed, 1);
  assert.equal(p.failed, 1);
  assert.equal(p.percent, 33);
  assert.deepEqual(p.stuckStepIds, [b.id]);
  assert.match(progressSummary(plan), /1\/3 steps \(33%\)/);
});

test("evaluatePlanValidity detects undone step results and broken deps", () => {
  const a = createStep({ title: "a", description: "", tool: null });
  const b = createStep({ title: "b", description: "", tool: null, dependsOn: [a.id] });
  const plan = createPlan("g", "s", [a, b]);
  a.status = "completed";

  const ok = evaluatePlanValidity(plan, [{ kind: "none" }]);
  assert.equal(ok.valid, true);

  const undone = evaluatePlanValidity(plan, [{ kind: "step-result-undone", stepId: a.id }]);
  assert.equal(undone.valid, true, "undone result invalidates the step but plan may be repairable");
  assert.deepEqual(undone.invalidStepIds, [a.id]);

  a.status = "failed";
  const dep = evaluatePlanValidity(plan, []);
  assert.equal(dep.valid, false);
  assert.match(dep.reason ?? "", /depend on failed/);
});

test("invalidateDownstream cancels transitively dependent pending steps", () => {
  const a = createStep({ title: "a", description: "", tool: null });
  const b = createStep({ title: "b", description: "", tool: null, dependsOn: [a.id] });
  const c = createStep({ title: "c", description: "", tool: null, dependsOn: [b.id] });
  const d = createStep({ title: "d", description: "", tool: null });
  const plan = createPlan("g", "s", [a, b, c, d]);
  const cancelled = invalidateDownstream(plan, [a.id], "step-unrepairable");
  assert.equal(cancelled.length, 2);
  assert.equal(b.status, "cancelled");
  assert.equal(c.status, "cancelled");
  assert.equal(d.status, "pending");
});

test("createAdaptiveStep encodes expectation into verify hint", () => {
  const { step, expectation } = createAdaptiveStep({
    title: "write config",
    description: "write",
    tool: "file.write",
    args: { path: "x", content: "y" },
    expectation: { outcome: "file exists on disk", alternativeTools: ["command.run"], onFailure: ["check disk space"] },
  });
  assert.equal(step.verify, "file exists on disk");
  assert.equal(expectation?.alternativeTools?.[0], "command.run");
});

// ── decision engine ───────────────────────────────────────────────────────────

test("decision engine executes next runnable step with risk + permission", () => {
  const reg = registryWithTool("file.write", "SAFE_WRITE");
  const engine = new HeuristicDecisionEngine(reg);
  const s = createStep({ title: "w", description: "", tool: "file.write" });
  const plan = createPlan("g", "s", [s]);
  const d = engine.decide({
    goal: "g", plan, observations: [], replansUsed: 0, maxReplans: 2, stepsExecuted: 0, maxSteps: 10,
  });
  assert.equal(d.action, "execute-step");
  assert.equal(d.stepId, s.id);
  assert.equal(d.target, "file.write");
  assert.equal(d.risk, "low");
  assert.equal(d.requiredPermission, "SAFE_WRITE");
});

test("decision engine waits for approval on permission failures", () => {
  const reg = registryWithTool("command.run", "USER_CONFIRMATION");
  const engine = new HeuristicDecisionEngine(reg);
  const s = createStep({ title: "r", description: "", tool: "command.run" });
  s.status = "failed";
  const plan = createPlan("g", "s", [s]);
  const d = engine.decide({
    goal: "g", plan,
    observations: [obsFail("command.run", "E_PERMISSION_DENIED", "denied", s.id)],
    replansUsed: 0, maxReplans: 2, stepsExecuted: 1, maxSteps: 10,
  });
  assert.equal(d.action, "wait-approval");
  assert.equal(d.diagnosisCategory, "permission");
});

test("decision engine replans then aborts when budget exhausted", () => {
  const reg = registryWithTool("file.write");
  const engine = new HeuristicDecisionEngine(reg);
  const s = createStep({ title: "w", description: "", tool: "file.write" });
  s.status = "failed";
  const plan = createPlan("g", "s", [s]);
  const obs = [obsFail("file.write", "E_TOOL_EXECUTION", "disk error", s.id)];

  const d1 = engine.decide({ goal: "g", plan, observations: obs, replansUsed: 0, maxReplans: 2, stepsExecuted: 1, maxSteps: 10 });
  assert.equal(d1.action, "replan");

  const d2 = engine.decide({ goal: "g", plan, observations: obs, replansUsed: 2, maxReplans: 2, stepsExecuted: 5, maxSteps: 10 });
  assert.equal(d2.action, "abort");
});

test("decision engine aborts at step budget", () => {
  const engine = new HeuristicDecisionEngine(registryWithTool("file.write"));
  const s = createStep({ title: "w", description: "", tool: "file.write" });
  const plan = createPlan("g", "s", [s]);
  const d = engine.decide({ goal: "g", plan, observations: [], replansUsed: 0, maxReplans: 2, stepsExecuted: 60, maxSteps: 60 });
  assert.equal(d.action, "abort");
});

// ── diagnosis ─────────────────────────────────────────────────────────────────

test("diagnosis maps error codes to categories and recommendations", () => {
  const timeout = diagnose(obsFail("command.run", "E_STEP_TIMEOUT", "timed out"));
  assert.equal(timeout.category, "timeout");
  assert.equal(timeout.recommendation, "retry-with-backoff");
  assert.equal(timeout.transient, true);

  const perm = diagnose(obsFail("file.write", "E_PERMISSION_DENIED", "no"));
  assert.equal(perm.category, "permission");
  assert.equal(perm.recommendation, "request-approval");
  assert.equal(perm.retryable, false);

  const args = diagnose(obsFail("file.write", "E_TOOL_ARGUMENTS_INVALID", "bad path"));
  assert.equal(args.recommendation, "repair-args");

  const dep = diagnose(obsFail("python.execute", "E_PYTHON_MODULE_NOT_FOUND", "module missing"));
  assert.equal(dep.category, "dependency");
});

test("diagnosis falls back to message heuristics for unknown codes", () => {
  assert.equal(categorize({ name: "X", code: "E_WEIRD" as never, message: "connection refused to host", details: {} }), "network");
  assert.equal(categorize({ name: "X", code: "E_WEIRD" as never, message: "somefile.txt not found", details: {} }), "state");
  assert.ok(isPermissionProblem(obsFail("t", "E_APPROVAL_REJECTED", "no").error));
});

// ── verification ──────────────────────────────────────────────────────────────

test("verifyResult distinguishes tool success from rule failures", () => {
  const okObs = obsOk("command.run", { exitCode: 0, stdout: "done" });
  const v1 = verifyResult(okObs, [resultRules.exitCodeZero()]);
  assert.equal(v1.passed, true);

  const badObs = obsOk("command.run", { exitCode: 1, stdout: "" });
  const v2 = verifyResult(badObs, [resultRules.exitCodeZero()]);
  assert.equal(v2.passed, false);
  assert.match(v2.note, /exitCode/);
});

test("verifyState runs predicates and reports failures", async () => {
  const v = await verifyState("target-x", [
    { name: "exists", predicate: async () => ({ pass: true, detail: "found" }) },
    { name: "size", predicate: async () => ({ pass: false, detail: "0 bytes" }) },
  ]);
  assert.equal(v.passed, false);
  assert.equal(v.kind, "state");
  assert.match(v.note, /state mismatch/);
});

test("verifyState survives throwing predicates", async () => {
  const v = await verifyState("t", [
    { name: "boom", predicate: async () => { throw new Error("controller exploded"); } },
  ]);
  assert.equal(v.passed, false);
  assert.match(v.note, /exploded/);
});

test("verifyGoal checks completion criteria over plan + observations", async () => {
  const a = createStep({ title: "a", description: "", tool: null });
  a.status = "completed";
  const plan = createPlan("g", "s", [a]);

  const passed = await verifyGoal("g", plan, [], {
    requiredChecks: [{ name: "has-observation", fromObservations: (obs) => ({ pass: obs.length >= 0, detail: `${obs.length}` }) }],
    minCompletedFraction: 1,
  });
  assert.equal(passed.passed, true);

  // Incomplete two-step plan must fail with default criteria.
  const inner = createPlan("g", "s", [a, createStep({ title: "b", description: "", tool: null })]);

  const failed = await verifyGoal("g", inner, [], defaultCompletionCriteria(inner));
  assert.equal(failed.passed, false, "incomplete plan must fail goal verification");
});

// ── observation engine ────────────────────────────────────────────────────────

test("observation engine extracts state changes, evidence, side effects", () => {
  const engine = new ObservationEngine({ slowToolThresholdMs: 1000 });
  const e1 = engine.enrich(obsOk("file.write", { path: "/x/y.txt", bytesWritten: 10 }));
  assert.equal(e1.success, true);
  assert.ok(e1.evidence.length >= 2, "output fields become evidence");
  assert.ok(e1.stateChanges.length >= 1, "file.write success implies filesystem change");

  const e2 = engine.enrich(obsFail("file.delete", "E_INTERNAL", "boom"));
  assert.ok(e2.sideEffects.some((s) => s.severity === "warning"), "failed mutating tool warns about partial changes");
  assert.equal(e2.evidence[0]!.kind, "error-payload");

  const slow = engine.enrich(makeObservation({ sessionId: "s", toolName: "command.run", callId: "c", ok: true, output: {}, durationMs: 5000 }));
  assert.ok(slow.evidence.some((ev) => ev.kind === "duration-anomaly"));
});
