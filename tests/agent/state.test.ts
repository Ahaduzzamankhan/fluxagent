/**
 * State + Observer tests: serializable AgentState, transitions, observation
 * recording through the Observer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { StateManager, serializeState, deserializeState } from "../../src/agent/state.ts";
import { Observer } from "../../src/agent/observer.ts";
import { InMemoryShortTermMemory } from "../../src/memory/short-term.ts";
import { createPlan, createStep } from "../../src/planning/plan.ts";
import type { ToolExecutionResult } from "../../src/tools/tool.ts";

function fakeResult(ok: boolean): ToolExecutionResult {
  return {
    ok,
    toolName: "file.write",
    callId: "call_1",
    ...(ok ? { output: { written: true } } : { error: { code: "E_INTERNAL", message: "boom" } }),
    durationMs: 5,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

test("state manager tracks plan, steps, observations, errors", () => {
  const sm = new StateManager("sess-1", "do thing");
  const step = createStep({ title: "s1", description: "s1", tool: "file.write" });
  const plan = createPlan("do thing", "sum", [step]);
  sm.setPlan(plan);
  sm.updateStep(step.id, (s) => {
    s.status = "completed";
  });
  sm.addObservation({
    id: "obs_1",
    sessionId: "sess-1",
    toolName: "file.write",
    callId: "call_1",
    ok: true,
    error: null,
    durationMs: 3,
    at: new Date().toISOString(),
  });
  sm.addError({ name: "X", code: "E_INTERNAL", message: "later problem", details: {} });
  sm.setFinalResult({ status: "completed", summary: "done", at: new Date().toISOString() });

  const state = sm.get();
  assert.equal(state.plan!.steps[0]!.status, "completed");
  assert.equal(state.observations.length, 1);
  assert.equal(state.errors.length, 1);
  assert.equal(state.finalResult!.status, "completed");
  assert.equal(state.goal, "do thing");
});

test("AgentState serializes and restores losslessly", () => {
  const sm = new StateManager("sess-2", "goal here");
  sm.setGoal("goal changed");
  sm.incrementStepCount();
  sm.incrementStepCount();
  const json = serializeState(sm.get());
  const restored = deserializeState(json);
  assert.equal(restored.sessionId, "sess-2");
  assert.equal(restored.goal, "goal changed");
  assert.equal(restored.stepCount, 2);
  assert.equal(restored.plan, null);
});

test("observer records observations into state and memory", () => {
  const sm = new StateManager("sess-3", "g");
  const mem = new InMemoryShortTermMemory();
  const observer = new Observer({ sessionId: "sess-3", state: sm, memory: mem });
  const okObs = observer.observe(fakeResult(true), { stepId: "s1" });
  assert.equal(okObs.ok, true);
  assert.equal(sm.get().observations.length, 1);
  assert.equal(mem.recentObservations().length, 1);

  const failObs = observer.observe(fakeResult(false), { stepId: "s1" });
  const verdict = observer.verify(failObs, { goal: "g" });
  assert.equal(verdict.pass, false);
});

test("observer applies file verifier for file.exists misses", () => {
  const sm = new StateManager("sess-4", "g");
  const observer = new Observer({ sessionId: "sess-4", state: sm, memory: new InMemoryShortTermMemory() });
  const res = fakeResult(true);
  const withExists = { ...res, toolName: "file.exists", output: { path: "x", exists: false } };
  const obs = observer.observe(withExists);
  const verdict = observer.verify(obs, { goal: "g" });
  assert.equal(verdict.pass, false, "exists=false must fail verification");
});
