/**
 * FluxAgent — evaluation, benchmarking & diagnostics (Phase 11).
 *
 * Evaluation framework (11.1): run a goal under an evaluator, capture metrics
 * (success, duration, tool usage, retries, recovery, verification), and score
 * with pluggable correctness checks.
 *
 * Benchmark suite (11.2): declarative benchmark cases grouped by category,
 * executed against a runtime factory + mock provider — no network, no keys.
 * Regression (11.3): compare two benchmark reports field by field.
 *
 * Diagnostics (11.4/11.5): structured, chain-of-thought-free explanations of
 * a finished run assembled from the trace recorder + state.
 */

import type { FluxRuntime } from "../runtime/runtime.ts";
import type { AgentEvent } from "../events/events.ts";
import type { TraceRecorder, TraceRecord } from "../runtime/trace.ts";
import type { Logger } from "../utils/logger.ts";

// ─── 11.1 Evaluation framework ────────────────────────────────────────────────

export interface EvalCase {
  readonly id: string;
  readonly goal: string;
  readonly category: BenchmarkCategory;
  /** Correctness checks over the run result + session state. */
  readonly checks: readonly EvalCheck[];
  /** Fail the case if it takes longer than this. */
  readonly timeoutMs?: number;
}

export interface EvalCheck {
  readonly name: string;
  check: (ctx: EvalContext) => { pass: boolean; detail: string };
}

export interface EvalContext {
  readonly result: { status: string; summary: string; stepsCompleted: number; stepsFailed: number; durationMs: number };
  readonly events: readonly AgentEvent[];
  readonly toolCalls: readonly string[];
  readonly retries: number;
  readonly recoveries: number;
}

export interface EvalCaseResult {
  readonly caseId: string;
  readonly category: BenchmarkCategory;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly toolCalls: number;
  readonly retries: number;
  readonly recoveries: number;
  readonly verification: "passed" | "failed" | "none";
  readonly checks: readonly { name: string; pass: boolean; detail: string }[];
  readonly error?: string;
}

export const evalChecks = {
  completed: (): EvalCheck => ({
    name: "run-completed",
    check: (ctx) => ({ pass: ctx.result.status === "completed", detail: `status=${ctx.result.status}` }),
  }),
  noFailedSteps: (): EvalCheck => ({
    name: "no-failed-steps",
    check: (ctx) => ({ pass: ctx.result.stepsFailed === 0, detail: `failedSteps=${ctx.result.stepsFailed}` }),
  }),
  toolsUsed: (expected: readonly string[]): EvalCheck => ({
    name: `tools-used:${expected.join(",")}`,
    check: (ctx) => {
      const missing = expected.filter((t) => !ctx.toolCalls.includes(t));
      return { pass: missing.length === 0, detail: missing.length === 0 ? "all used" : `missing: ${missing.join(", ")}` };
    },
  }),
  finishedWithin: (ms: number): EvalCheck => ({
    name: `finished-within-${ms}ms`,
    check: (ctx) => ({ pass: ctx.result.durationMs <= ms, detail: `${Math.round(ctx.result.durationMs)}ms` }),
  }),
  completedWithoutRecovery: (): EvalCheck => ({
    name: "no-recovery-needed",
    check: (ctx) => ({ pass: ctx.recoveries === 0, detail: `recoveries=${ctx.recoveries}` }),
  }),
} as const;

export interface EvalRunOptions {
  readonly concurrency?: number;
  readonly logger?: Logger;
}

export class Evaluator {
  async runCase(runtimeFactory: () => FluxRuntime, testCase: EvalCase, options: EvalRunOptions = {}): Promise<EvalCaseResult> {
    const startedAt = Date.now();
    const runtime = runtimeFactory();
    const session = runtime.createSession({ goal: testCase.goal });
    const events: AgentEvent[] = [];
    session.bus.any((e) => {
      events.push(e as AgentEvent);
    });

    let runError: string | undefined;
    try {
      const timeoutMs = testCase.timeoutMs ?? 60_000;
      await Promise.race([
        session.agent.run(testCase.goal),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`eval case timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    }

    const state = session.state.get();
    const toolCalls = events.filter((e) => e.type === "tool.called").map((e) => {
      const anyE = e as unknown as { toolName?: string };
      return anyE.toolName ?? "unknown";
    });
    const retries = events.filter((e) => e.type === "agent.recovered").length;
    const recoveries = retries;
    const durationMs = Date.now() - startedAt;

    const ctx: EvalContext = {
      result: {
        status: runError ? "failed" : state.finalResult?.status ?? "completed",
        summary: state.finalResult?.summary ?? runError ?? "",
        stepsCompleted: state.plan?.steps.filter((s) => s.status === "completed").length ?? 0,
        stepsFailed: state.plan?.steps.filter((s) => s.status === "failed").length ?? 0,
        durationMs,
      },
      events,
      toolCalls,
      retries,
      recoveries,
    };

    const checks = testCase.checks.map((c) => ({ name: c.name, ...c.check(ctx) }));
    void options;
    await session.end("eval-finished");
    return {
      caseId: testCase.id,
      category: testCase.category,
      passed: !runError && checks.every((c) => c.pass),
      durationMs,
      toolCalls: toolCalls.length,
      retries,
      recoveries,
      verification: checks.length > 0 ? (checks.every((c) => c.pass) ? "passed" : "failed") : "none",
      checks,
      ...(runError ? { error: runError } : {}),
    };
  }

  async runSuite(runtimeFactory: () => FluxRuntime, cases: readonly EvalCase[], options: EvalRunOptions = {}): Promise<BenchmarkReport> {
    const results: EvalCaseResult[] = [];
    for (const c of cases) {
      results.push(await this.runCase(runtimeFactory, c, options));
    }
    return reportFrom(results);
  }
}

// ─── 11.2 Benchmark suite ─────────────────────────────────────────────────────

export type BenchmarkCategory =
  | "planning" | "reasoning" | "tool-usage" | "coding" | "memory"
  | "recovery" | "multi-step" | "parallel" | "long-running" | "api";

export interface BenchmarkReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly totalCases: number;
  readonly passed: number;
  readonly failed: number;
  readonly passRate: number;
  readonly byCategory: Readonly<Record<string, { total: number; passed: number; avgDurationMs: number }>>;
  readonly cases: readonly EvalCaseResult[];
}

export function reportFrom(results: readonly EvalCaseResult[]): BenchmarkReport {
  const byCategory: Record<string, { total: number; passed: number; avgDurationMs: number }> = {};
  for (const r of results) {
    byCategory[r.category] ??= { total: 0, passed: 0, avgDurationMs: 0 };
    const bucket = byCategory[r.category]!;
    bucket.total++;
    if (r.passed) bucket.passed++;
    bucket.avgDurationMs += r.durationMs;
  }
  for (const bucket of Object.values(byCategory)) {
    bucket.avgDurationMs = Math.round(bucket.avgDurationMs / bucket.total);
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalCases: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : Math.round((passed / results.length) * 100) / 100,
    byCategory,
    cases: results,
  };
}

/** Built-in benchmark cases exercising the brain with the mock provider. */
export function defaultBenchmarkCases(): readonly EvalCase[] {
  return [
    {
      id: "plan-simple-goal", category: "planning", goal: "read the file notes.txt",
      checks: [evalChecks.completed(), evalChecks.noFailedSteps()],
    },
    {
      id: "multi-step-sequence", category: "multi-step", goal: "read the file a.txt and then write the file b.txt",
      checks: [evalChecks.completed()],
    },
    {
      id: "tool-usage-file-read", category: "tool-usage", goal: "find and read the file report.md",
      checks: [evalChecks.completed()],
    },
    {
      id: "recovery-mock-failure", category: "recovery", goal: "read the file missing-on-purpose.txt",
      checks: [evalChecks.toolsUsed(["file.read"])],
    },
  ];
}

/** 11.3 Regression: compare a report against a baseline. */
export function compareReports(baseline: BenchmarkReport, current: BenchmarkReport): {
  regressions: readonly string[];
  improvements: readonly string[];
} {
  const regressions: string[] = [];
  const improvements: string[] = [];
  if (current.passRate < baseline.passRate) regressions.push(`passRate ${baseline.passRate} → ${current.passRate}`);
  if (current.passRate > baseline.passRate) improvements.push(`passRate ${baseline.passRate} → ${current.passRate}`);
  for (const [cat, base] of Object.entries(baseline.byCategory)) {
    const now = current.byCategory[cat];
    if (!now) continue;
    if (now.avgDurationMs > base.avgDurationMs * 1.5) {
      regressions.push(`${cat} avg duration ${base.avgDurationMs}ms → ${now.avgDurationMs}ms`);
    } else if (now.avgDurationMs < base.avgDurationMs * 0.66) {
      improvements.push(`${cat} avg duration ${base.avgDurationMs}ms → ${now.avgDurationMs}ms`);
    }
  }
  return { regressions, improvements };
}

// ─── 11.4/11.5 Diagnostics ────────────────────────────────────────────────────

export interface RunDiagnostics {
  readonly sessionId: string;
  readonly goal: string;
  readonly outcome: string;
  readonly planSummary: { id: string; revision: number; steps: number; completed: number; failed: number } | null;
  readonly modelsUsed: readonly string[];
  readonly toolsCalled: readonly { tool: string; count: number }[];
  readonly decisions: readonly { at: string; action: string; reason: string }[];
  readonly failure: { stepId: string; reason: string; category: string; recovery: string } | null;
  readonly timeline: readonly { at: string; type: string; subject: string }[];
}

/**
 * Explain operationally what happened in a run — from structured metadata
 * (trace + state + events) only. Never exposes model chain-of-thought.
 */
export function buildDiagnostics(input: {
  sessionId: string;
  state: { goal: string; plan: { id: string; revision: number; steps: { id: string; status: string; title: string; error?: { message: string; code: string } }[] } | null; finalResult?: { status: string; summary: string } | null };
  trace?: TraceRecorder;
  events?: readonly AgentEvent[];
}): RunDiagnostics {
  const { state } = input;
  const plan = state.plan;
  const decisions: RunDiagnostics["decisions"] = [];
  const timeline: { at: string; type: string; subject: string }[] = [];
  const toolCounts = new Map<string, number>();
  const models = new Set<string>();

  if (input.trace) {
    for (const rec of input.trace.forTask(input.sessionId) as readonly TraceRecord[]) {
      if (rec.type === "decision.created") {
        decisions.push({ at: rec.at, action: String(rec.detail["action"] ?? "?"), reason: String(rec.detail["reason"] ?? "") });
      }
      timeline.push({ at: rec.at, type: rec.type, subject: String(rec.detail["subject"] ?? rec.decisionId ?? rec.stepId ?? "") });
    }
  }
  for (const e of input.events ?? []) {
    if (e.type === "tool.called") {
      const t = e as unknown as { toolName: string };
      toolCounts.set(t.toolName, (toolCounts.get(t.toolName) ?? 0) + 1);
    }
    if (e.type === "agent.thinking") {
      const anyE = e as unknown as { note?: string };
      const m = anyE.note?.match(/model ([\w:.-]+)/);
      if (m) models.add(m[1]!);
    }
    timeline.push({ at: e.timestamp, type: e.type, subject: e.sessionId });
  }

  const failedStep = plan?.steps.find((s) => s.status === "failed");
  return {
    sessionId: input.sessionId,
    goal: state.goal,
    outcome: state.finalResult?.status ?? (failedStep ? "failed" : "unknown"),
    planSummary: plan
      ? {
          id: plan.id,
          revision: plan.revision,
          steps: plan.steps.length,
          completed: plan.steps.filter((s) => s.status === "completed").length,
          failed: plan.steps.filter((s) => s.status === "failed").length,
        }
      : null,
    modelsUsed: [...models],
    toolsCalled: [...toolCounts.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
    decisions: decisions.slice(-20),
    failure: failedStep
      ? {
          stepId: failedStep.id,
          reason: failedStep.error?.message ?? "unknown",
          category: failedStep.error?.code ?? "unknown",
          recovery: "see trace recovery records",
        }
      : null,
    timeline: timeline.slice(-50),
  };
}
