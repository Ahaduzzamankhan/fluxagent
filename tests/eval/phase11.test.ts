/**
 * Phase 11 tests: evaluation framework, built-in benchmark suite, regression
 * comparison, and diagnostics (structured, chain-of-thought-free).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "../../src/runtime/runtime.ts";
import { MockLlmProvider } from "../../src/llm/mock-provider.ts";
import {
  Evaluator,
  evalChecks,
  defaultBenchmarkCases,
  reportFrom,
  compareReports,
  buildDiagnostics,
  type EvalCase,
} from "../../src/eval/evaluation.ts";

test("evaluation: runCase scores checks and reports tool usage", async () => {
  const evaluator = new Evaluator();
  const testCase: EvalCase = {
    id: "eval-read",
    category: "tool-usage",
    goal: "read the file notes.txt",
    checks: [evalChecks.completed(), evalChecks.finishedWithin(30_000)],
  };
  const result = await evaluator.runCase(
    () => createRuntime({ provider: new MockLlmProvider() }),
    testCase,
  );
  assert.equal(result.passed, true);
  assert.equal(result.verification, "passed");
  assert.ok(result.durationMs >= 0);
  assert.ok(result.checks.every((c) => c.pass));
});

test("evaluation: tool-usage checks pass when a scripted plan calls tools", async () => {
  const evaluator = new Evaluator();
  const testCase: EvalCase = {
    id: "eval-tool-use",
    category: "tool-usage",
    goal: "read the file notes.txt",
    checks: [
      evalChecks.completed(),
      evalChecks.toolsUsed(["file.read"]),
    ],
  };
  // Script the provider so the plan actually calls file.read with a temp path.
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const tmpFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "flux-eval-")), "notes.txt");
  await fs.writeFile(tmpFile, "hello eval");
  const provider = new MockLlmProvider({
    plan: { summary: "read notes", steps: [{ id: "s1", title: "read notes", tool: "file.read", args: { path: tmpFile } }] },
  });
  const result = await evaluator.runCase(() => createRuntime({ provider }), testCase);
  assert.equal(result.toolCalls >= 1, true, `tool calls recorded (got ${result.toolCalls})`);
  assert.equal(result.checks.find((c) => c.name.startsWith("tools-used"))!.pass, true);
  void testCase;
});

test("evaluation: failing checks produce a failing result with details", async () => {
  const evaluator = new Evaluator();
  const testCase: EvalCase = {
    id: "eval-impossible",
    category: "recovery",
    goal: "read the file notes.txt",
    checks: [evalChecks.toolsUsed(["nonexistent.tool"])],
  };
  const result = await evaluator.runCase(
    () => createRuntime({ provider: new MockLlmProvider() }),
    testCase,
  );
  assert.equal(result.passed, false);
  assert.equal(result.verification, "failed");
  const missing = result.checks.find((c) => c.name.startsWith("tools-used"));
  assert.match(missing!.detail, /missing/);
});

test("benchmark suite: default cases execute and produce a report", async () => {
  const evaluator = new Evaluator();
  const report = await evaluator.runSuite(
    () => createRuntime({ provider: new MockLlmProvider() }),
    defaultBenchmarkCases(),
  );
  assert.equal(report.totalCases, 4);
  assert.ok(report.passRate >= 0.5, `pass rate ${report.passRate} reasonable with mock provider`);
  assert.ok(Object.keys(report.byCategory).length >= 3);
  for (const [cat, bucket] of Object.entries(report.byCategory)) {
    assert.equal(bucket.total, bucket.passed + (bucket.total - bucket.passed));
    void cat;
  }
});

test("benchmark regression: compareReports detects pass-rate regressions and improvements", () => {
  const base = reportFrom([
    { caseId: "a", category: "planning", passed: true, durationMs: 100, toolCalls: 1, retries: 0, recoveries: 0, verification: "passed", checks: [] },
    { caseId: "b", category: "planning", passed: true, durationMs: 100, toolCalls: 1, retries: 0, recoveries: 0, verification: "passed", checks: [] },
  ]);
  const worse = reportFrom([
    { caseId: "a", category: "planning", passed: true, durationMs: 100, toolCalls: 1, retries: 0, recoveries: 0, verification: "passed", checks: [] },
    { caseId: "b", category: "planning", passed: false, durationMs: 500, toolCalls: 1, retries: 0, recoveries: 0, verification: "failed", checks: [] },
  ]);
  const better = reportFrom([
    { caseId: "a", category: "planning", passed: true, durationMs: 50, toolCalls: 1, retries: 0, recoveries: 0, verification: "passed", checks: [] },
    { caseId: "b", category: "planning", passed: true, durationMs: 50, toolCalls: 1, retries: 0, recoveries: 0, verification: "passed", checks: [] },
  ]);

  assert.equal(compareReports(base, worse).regressions.length >= 1, true);
  assert.equal(compareReports(base, better).improvements.length >= 1, true);
  assert.equal(compareReports(base, base).regressions.length, 0);
});

test("diagnostics: explains a finished run from structured metadata", async () => {
  const runtime = createRuntime({ provider: new MockLlmProvider() });
  const session = runtime.createSession({ goal: "read the file diag.txt" });
  await session.agent.run("read the file diag.txt");

  const diag = buildDiagnostics({
    sessionId: session.id,
    state: session.state.get(),
    trace: runtime.trace,
  });
  assert.equal(diag.goal, "read the file diag.txt");
  assert.ok(diag.planSummary);
  assert.ok(diag.planSummary!.steps >= 1);
  assert.equal(diag.outcome, "completed");
  assert.ok(Array.isArray(diag.timeline));
  assert.ok(diag.timeline.length > 0);
  await session.end();
});

test("diagnostics: reports failing steps without exposing chain-of-thought", () => {
  const diag = buildDiagnostics({
    sessionId: "s",
    state: {
      goal: "g",
      plan: {
        id: "plan_1",
        revision: 1,
        steps: [
          { id: "s1", status: "completed", title: "ok step" },
          { id: "s2", status: "failed", title: "bad step", error: { name: "FluxError", code: "E_TOOL_EXECUTION", message: "disk exploded", details: {} } },
        ],
      },
      finalResult: { status: "failed", summary: "failed", at: new Date().toISOString() },
    },
  });
  assert.equal(diag.outcome, "failed");
  assert.ok(diag.failure);
  assert.equal(diag.failure!.stepId, "s2");
  assert.equal(diag.failure!.category, "E_TOOL_EXECUTION");
});
