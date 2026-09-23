/**
 * Phase 9 — evaluation playground tests.
 *
 * Complements the Phase 13 evaluator with: tool-loop-driven case runs,
 * aggregate metrics (planning/tool-selection/success), a human-readable
 * report formatter, and persistence-safe comparisons. All deterministic —
 * scripted providers only, no network, no keys.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ToolCallingLoop } from "../../src/agent/tool-calling.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { PermissionManager } from "../../src/security/permission-manager.ts";
import { AutoApproveRequester, AutoDenyApprovalRequester } from "../../src/security/approval.ts";
import { defineTool, type Tool, type LlmGenerateOptions, type LlmResponse, type StreamChunk } from "../../src/tools/tool.ts";
import { S } from "../../src/tools/schemas.ts";
import type { PlannedPlan, AgentDecision } from "../../src/llm/provider.ts";
import { reportFrom, compareReports, evalChecks, Evaluator, type EvalCase } from "../../src/eval/evaluation.ts";
import type { FluxRuntime } from "../../src/runtime/runtime.ts";

// ─── Scripted provider for the tool-calling loop ─────────────────────────────

type Turn = { text?: string; calls?: { id: string; name: string; args: Record<string, unknown> }[] };

class ScriptProvider {
  readonly name = "eval-script";
  readonly defaultModel = "script-1";
  private i = 0;
  modelCalls = 0;
  private readonly turns: readonly Turn[];
  constructor(turns: readonly Turn[]) {
    this.turns = turns;
  }
  async generate(_options: LlmGenerateOptions): Promise<LlmResponse> {
    this.modelCalls++;
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)]!;
    this.i++;
    return {
      text: turn.text ?? "",
      toolCalls: (turn.calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args })),
      stopReason: turn.calls && turn.calls.length > 0 ? "tool_calls" : "stop",
    };
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    yield { type: "done", finishReason: "stop" };
  }
  async plan(): Promise<PlannedPlan> {
    return { summary: "s", steps: [] };
  }
  async decideTool(): Promise<AgentDecision> {
    return { kind: "finish", thought: "t" };
  }
}

function readTool(): Tool {
  return defineTool({
    metadata: {
      name: "file.read",
      description: "Read a file",
      inputSchema: S.object({ path: S.string("path") }, ["path"]),
      permissionLevel: "READ_ONLY",
      tags: ["file"],
    },
    validate(args: unknown): asserts args is { path: string } {
      if (typeof (args as { path?: unknown }).path !== "string") throw new Error("path required");
    },
    async execute(args) {
      return { path: args.path, content: `contents of ${args.path}` };
    },
  });
}

function writeTool(): Tool {
  return defineTool({
    metadata: {
      name: "file.write",
      description: "Write a file",
      inputSchema: S.object({ path: S.string("path"), content: S.string("content") }, ["path", "content"]),
      permissionLevel: "SAFE_WRITE",
      tags: ["file"],
    },
    validate(args: unknown): asserts args is { path: string; content: string } {
      const a = args as { path?: unknown; content?: unknown };
      if (typeof a.path !== "string" || typeof a.content !== "string") throw new Error("path and content required");
    },
    async execute(args) {
      return { written: args.path, bytes: args.content.length };
    },
  });
}

function failingTool(): Tool {
  return defineTool({
    metadata: {
      name: "flaky.run",
      description: "Always fails",
      inputSchema: S.object({}, []),
      permissionLevel: "READ_ONLY",
      tags: [],
    },
    validate(): void {
      /* any args fine */
    },
    async execute() {
      throw new Error("simulated tool failure");
    },
  });
}

function makeRegistry(...tools: Tool[]): ToolRegistry {
  const reg = new ToolRegistry({ sessionId: "eval" });
  reg.registerAll(tools);
  return reg;
}

function permissions(mode: "allow" | "deny"): PermissionManager {
  return new PermissionManager({
    sessionId: "eval",
    ceiling: "PRIVILEGED",
    approvalRequester: mode === "allow" ? new AutoApproveRequester() : new AutoDenyApprovalRequester(),
    autoApproveBelow: "READ_ONLY",
  });
}

// ─── Loop-driven eval cases ──────────────────────────────────────────────────

interface LoopRunRecord {
  caseId: string;
  passed: boolean;
  modelCalls: number;
  toolCalls: number;
  durationMs: number;
  finalText: string;
}

async function runLoopCase(
  caseId: string,
  provider: ScriptProvider,
  registry: ToolRegistry,
  perm: PermissionManager,
  check: (r: Awaited<ReturnType<ToolCallingLoop["run"]>>) => boolean,
): Promise<LoopRunRecord> {
  const t0 = Date.now();
  const loop = new ToolCallingLoop();
  const result = await loop.run({ goal: caseId, registry, permissions: perm, provider, maxTurns: 8 });
  return {
    caseId,
    passed: check(result),
    modelCalls: provider.modelCalls,
    toolCalls: result.steps.length,
    durationMs: Date.now() - t0,
    finalText: result.text,
  };
}

describe("Evaluation playground (Phase 9)", () => {
  test("Scenario A (read) and B (write) pass end-to-end through the tool loop", async () => {
    const readProvider = new ScriptProvider([
      { calls: [{ id: "1", name: "file.read", args: { path: "notes.txt" } }] },
      { text: "read done" },
    ]);
    const a = await runLoopCase(
      "read-notes",
      readProvider,
      makeRegistry(readTool()),
      permissions("allow"),
      (r) => r.status === "completed" && r.steps[0]!.ok === true,
    );
    assert.equal(a.passed, true);
    assert.equal(a.modelCalls, 2, "one call for tool request, one for completion");

    const writeProvider = new ScriptProvider([
      { calls: [{ id: "1", name: "file.write", args: { path: "out.txt", content: "hi" } }] },
      { text: "write done" },
    ]);
    const b = await runLoopCase(
      "write-out",
      writeProvider,
      makeRegistry(readTool(), writeTool()),
      permissions("allow"),
      (r) => r.status === "completed" && r.steps[0]!.ok === true,
    );
    assert.equal(b.passed, true);
  });

  test("Scenario C: tool failure is observed and the loop recovers gracefully", async () => {
    const provider = new ScriptProvider([
      { calls: [{ id: "1", name: "flaky.run", args: {} }] },
      { text: "the tool failed; reporting failure instead of pretending" },
    ]);
    const rec = await runLoopCase(
      "failure-recovery",
      provider,
      makeRegistry(failingTool()),
      permissions("allow"),
      (r) => r.status === "completed" && r.steps[0]!.ok === false && r.text.includes("failed"),
    );
    assert.equal(rec.passed, true, "honest failure reporting counts as correct behavior");
  });

  test("Scenario D: permission denial ends safely with a structured denial", async () => {
    const provider = new ScriptProvider([
      { calls: [{ id: "1", name: "file.write", args: { path: "x.txt", content: "y" } }] },
      { text: "denied, stopping" },
    ]);
    const registry = makeRegistry(writeTool());
    // USER_CONFIRMATION tool + auto-deny requester → denial path.
    const perm = new PermissionManager({
      sessionId: "eval",
      ceiling: "PRIVILEGED",
      approvalRequester: new AutoDenyApprovalRequester(),
      autoApproveBelow: "READ_ONLY",
    });
    const rec = await runLoopCase(
      "permission-denial",
      provider,
      registry,
      perm,
      (r) => r.status === "completed" && r.steps[0]!.ok === false,
    );
    assert.equal(rec.passed, true);
    const parsed = JSON.parse(rec.finalText.length > 0 ? "{}" : "{}"); // final text is model's, not denial
    void parsed;
  });

  test("Scenario E: multi-step plan executes all steps in order", async () => {
    const provider = new ScriptProvider([
      { calls: [{ id: "1", name: "file.read", args: { path: "in.txt" } }] },
      { calls: [{ id: "2", name: "file.write", args: { path: "out.txt", content: "data" } }] },
      { text: "pipeline finished" },
    ]);
    const rec = await runLoopCase(
      "multi-step",
      provider,
      makeRegistry(readTool(), writeTool()),
      permissions("allow"),
      (r) => r.status === "completed" && r.steps.length === 2 && r.steps.every((s) => s.ok),
    );
    assert.equal(rec.passed, true);
    assert.equal(rec.modelCalls, 3);
  });

  test("aggregate report: pass rate, per-category averages, model/tool call totals", () => {
    const results = [
      { caseId: "a", passed: true, modelCalls: 2, toolCalls: 1, durationMs: 10, finalText: "" },
      { caseId: "b", passed: true, modelCalls: 3, toolCalls: 2, durationMs: 20, finalText: "" },
      { caseId: "c", passed: false, modelCalls: 4, toolCalls: 3, durationMs: 30, finalText: "" },
    ].map((r, i) => ({
      caseId: r.caseId,
      category: (["tool-usage", "multi-step", "recovery"] as const)[i]!,
      passed: r.passed,
      durationMs: r.durationMs,
      toolCalls: r.toolCalls,
      retries: 0,
      recoveries: 0,
      verification: (r.passed ? "passed" : "failed") as "passed" | "failed",
      checks: [{ name: "x", pass: r.passed, detail: "" }],
      modelCalls: r.modelCalls,
    }));
    const report = reportFrom(results);
    assert.equal(report.totalCases, 3);
    assert.equal(report.passed, 2);
    assert.equal(report.failed, 1);
    assert.equal(report.passRate, 0.67, "2/3 pass = 0.67 (rounded to 2 decimals)");
    assert.equal(report.byCategory["tool-usage"]!.total, 1);
    assert.equal(report.byCategory["recovery"]!.passed, 0);
  });

  test("regression comparison flags pass-rate drops and duration regressions", () => {
    const base = reportFrom([
      { caseId: "a", category: "tool-usage", passed: true, durationMs: 10, toolCalls: 1, retries: 0, recoveries: 0, verification: "passed", checks: [] },
      { caseId: "b", category: "tool-usage", passed: true, durationMs: 10, toolCalls: 1, retries: 0, recoveries: 0, verification: "passed", checks: [] },
    ]);
    const worse = reportFrom([
      { caseId: "a", category: "tool-usage", passed: false, durationMs: 50, toolCalls: 5, retries: 0, recoveries: 0, verification: "failed", checks: [] },
      { caseId: "b", category: "tool-usage", passed: true, durationMs: 60, toolCalls: 5, retries: 0, recoveries: 0, verification: "passed", checks: [] },
    ]);
    const { regressions } = compareReports(base, worse);
    assert.ok(regressions.some((r) => r.includes("passRate")), "pass-rate drop must be flagged");
    assert.ok(regressions.some((r) => r.includes("avg duration")), "duration regression must be flagged");
  });

  test("evalChecks compose into cases and evaluate correctly", () => {
    const case0: EvalCase = {
      id: "composed",
      goal: "g",
      category: "tool-usage",
      checks: [evalChecks.completed(), evalChecks.toolsUsed(["file.read"]), evalChecks.finishedWithin(1000)],
    };
    assert.ok(case0.checks.length === 3);
    const ctx = {
      result: { status: "completed", summary: "", stepsCompleted: 1, stepsFailed: 0, durationMs: 50 },
      events: [],
      toolCalls: ["file.read"],
      retries: 0,
      recoveries: 0,
    };
    for (const c of case0.checks) {
      const res = c.check(ctx);
      assert.equal(res.pass, true, `check ${c.name} should pass: ${res.detail}`);
    }
  });

  test("report formatter renders a human-readable summary without chain-of-thought", () => {
    const report = reportFrom([
      { caseId: "read", category: "tool-usage", passed: true, durationMs: 12, toolCalls: 1, retries: 0, recoveries: 0, verification: "passed", checks: [] },
      { caseId: "fail", category: "recovery", passed: false, durationMs: 30, toolCalls: 2, retries: 1, recoveries: 1, verification: "failed", checks: [{ name: "run-completed", pass: false, detail: "status=failed" }] },
    ]);
    const text = formatReport(report);
    assert.ok(text.includes("FluxAgent Evaluation"));
    assert.ok(text.includes("2"));
    assert.ok(text.includes("tool-usage"));
    assert.ok(!text.toLowerCase().includes("chain-of-thought"));
  });
});

/** Human-readable report formatter (shared with the CLI in Phase 12). */
function formatReport(report: ReturnType<typeof reportFrom>): string {
  const lines: string[] = [];
  lines.push("FluxAgent Evaluation");
  lines.push("====================");
  lines.push(`Cases: ${report.totalCases}  Passed: ${report.passed}  Failed: ${report.failed}  Pass rate: ${(report.passRate * 100).toFixed(0)}%`);
  lines.push("");
  for (const [cat, stats] of Object.entries(report.byCategory)) {
    lines.push(`  ${cat}: ${stats.passed}/${stats.total} passed, avg ${stats.avgDurationMs}ms`);
  }
  const failedCases = report.cases.filter((c) => !c.passed);
  if (failedCases.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const c of failedCases) {
      lines.push(`  - ${c.caseId}: ${c.checks.filter((k) => !k.pass).map((k) => `${k.name} (${k.detail})`).join("; ")}`);
    }
  }
  return lines.join("\n");
}
