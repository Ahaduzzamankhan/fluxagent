/**
 * Recovery tests: classification and decision policy (pure logic).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RecoveryManager } from "../../src/agent/recovery.ts";
import { makeObservation } from "../../src/agent/state.ts";
import { createStep } from "../../src/planning/plan.ts";

function obsWith(code: string | null, toolName = "file.write") {
  return makeObservation({
    sessionId: "s",
    toolName,
    callId: "c",
    ok: false,
    error: code ? { name: "FluxError", code: code as never, message: `boom ${code}`, details: {} } : null,
    durationMs: 1,
  });
}

const step = () => createStep({ title: "t", description: "t", tool: "file.write" });

test("permission failures are never retried", () => {
  const rm = new RecoveryManager();
  const d = rm.decide({ step: step(), observation: obsWith("E_PERMISSION_DENIED"), replansSoFar: 0, goal: "g" });
  assert.equal(d.action, "abort");
});

test("invalid args trigger replan with hints", () => {
  const rm = new RecoveryManager();
  const d = rm.decide({ step: step(), observation: obsWith("E_TOOL_ARGUMENTS_INVALID"), replansSoFar: 0, goal: "g" });
  assert.equal(d.action, "replan");
  assert.ok((d.replanHints?.length ?? 0) > 0);
});

test("transient failures retry with exponential backoff, then replan", () => {
  const rm = new RecoveryManager();
  const s = step();
  const d1 = rm.decide({ step: s, observation: obsWith("E_STEP_TIMEOUT"), replansSoFar: 0, goal: "g" });
  assert.equal(d1.action, "retry");
  assert.equal(d1.retryDelayMs, 500);
  s.retryCount = 1;
  const d2 = rm.decide({ step: s, observation: obsWith("E_STEP_TIMEOUT"), replansSoFar: 0, goal: "g" });
  assert.equal(d2.action, "retry");
  assert.equal(d2.retryDelayMs, 1000);
  s.retryCount = 5;
  const d3 = rm.decide({ step: s, observation: obsWith("E_STEP_TIMEOUT"), replansSoFar: 0, goal: "g" });
  assert.equal(d3.action, "replan", "retries exhausted must not loop forever");
});

test("permanent failures abort", () => {
  const rm = new RecoveryManager();
  const d = rm.decide({ step: step(), observation: obsWith("E_TOOL_EXECUTION"), replansSoFar: 0, goal: "g" });
  assert.equal(d.action, "abort");
});

test("cancelled observations abort immediately", () => {
  const rm = new RecoveryManager();
  const d = rm.decide({ step: step(), observation: obsWith("E_CANCELLED"), replansSoFar: 0, goal: "g" });
  assert.equal(d.action, "abort");
});
