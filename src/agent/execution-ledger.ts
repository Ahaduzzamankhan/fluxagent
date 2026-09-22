/**
 * FluxAgent — execution ledger (Phase 6.4).
 *
 * Records structured execution outcomes — never code changes:
 *   - per-tool reliability (successes/failures, average duration)
 *   - per-model reliability (routed by callers reporting outcomes)
 *   - per-strategy outcomes (successful strategies, failed strategies)
 *   - recovery success tracking
 *
 * The ledger is queried by the advanced decision engine (tool history →
 * confidence) and the strategy selector (salvage mode). Bounded in size;
 * entries aggregate so memory stays flat.
 */

import type { Logger } from "../utils/logger.ts";

export interface ToolOutcomeRecord {
  readonly successes: number;
  readonly failures: number;
  readonly totalDurationMs: number;
  readonly lastAt: string;
}

export interface ModelOutcomeRecord {
  readonly successes: number;
  readonly failures: number;
  readonly totalLatencyMs: number;
}

export interface StrategyOutcomeRecord {
  readonly runs: number;
  readonly successes: number;
  readonly failures: number;
  /** Sum of steps executed under this strategy. */
  readonly steps: number;
}

export interface RecoveryOutcomeRecord {
  readonly attempts: number;
  readonly succeeded: number;
}

export interface LedgerSnapshot {
  readonly tools: Readonly<Record<string, ToolOutcomeRecord>>;
  readonly models: Readonly<Record<string, ModelOutcomeRecord>>;
  readonly strategies: Readonly<Record<string, StrategyOutcomeRecord>>;
  readonly recovery: RecoveryOutcomeRecord;
}

export interface ExecutionLedgerOptions {
  readonly logger?: Logger;
  readonly maxTrackedTools?: number;
}

export class ExecutionLedger {
  private readonly tools = new Map<string, ToolOutcomeRecord>();
  private readonly models = new Map<string, ModelOutcomeRecord>();
  private readonly strategies = new Map<string, StrategyOutcomeRecord>();
  private readonly recovery: RecoveryOutcomeRecord = { attempts: 0, succeeded: 0 };
  private readonly logger?: Logger;

  constructor(options: ExecutionLedgerOptions = {}) {
    this.logger = options.logger;
  }

  recordToolOutcome(toolName: string, ok: boolean, durationMs: number): void {
    const prev = this.tools.get(toolName) ?? { successes: 0, failures: 0, totalDurationMs: 0, lastAt: "" };
    this.tools.set(toolName, {
      successes: prev.successes + (ok ? 1 : 0),
      failures: prev.failures + (ok ? 0 : 1),
      totalDurationMs: prev.totalDurationMs + Math.max(0, durationMs),
      lastAt: new Date().toISOString(),
    });
    this.logger?.debug("ledger: tool outcome", { toolName, ok, durationMs });
  }

  recordModelOutcome(modelId: string, ok: boolean, latencyMs?: number): void {
    const prev = this.models.get(modelId) ?? { successes: 0, failures: 0, totalLatencyMs: 0 };
    this.models.set(modelId, {
      successes: prev.successes + (ok ? 1 : 0),
      failures: prev.failures + (ok ? 0 : 1),
      totalLatencyMs: prev.totalLatencyMs + Math.max(0, latencyMs ?? 0),
    });
  }

  recordStrategyOutcome(strategy: string, ok: boolean, steps: number): void {
    const prev = this.strategies.get(strategy) ?? { runs: 0, successes: 0, failures: 0, steps: 0 };
    this.strategies.set(strategy, {
      runs: prev.runs + 1,
      successes: prev.successes + (ok ? 1 : 0),
      failures: prev.failures + (ok ? 0 : 1),
      steps: prev.steps + Math.max(0, steps),
    });
  }

  recordRecoveryOutcome(recovered: boolean): void {
    this.recovery.attempts += 1;
    if (recovered) this.recovery.succeeded += 1;
  }

  /** Success rate 0..1 for a tool, or undefined with no data. */
  toolSuccessRate(toolName: string): number | undefined {
    const r = this.tools.get(toolName);
    if (!r || r.successes + r.failures === 0) return undefined;
    return r.successes / (r.successes + r.failures);
  }

  /** Average duration for a tool, or undefined with no data. */
  toolAvgDurationMs(toolName: string): number | undefined {
    const r = this.tools.get(toolName);
    if (!r || r.successes + r.failures === 0) return undefined;
    return Math.round(r.totalDurationMs / (r.successes + r.failures));
  }

  /** The { successes, failures } map shape consumed by AdvancedDecisionEngine. */
  toolHistory(): ReadonlyMap<string, { successes: number; failures: number }> {
    const map = new Map<string, { successes: number; failures: number }>();
    for (const [name, r] of this.tools) map.set(name, { successes: r.successes, failures: r.failures });
    return map;
  }

  /** Best-performing strategies by success rate (min 1 run). */
  rankedStrategies(): readonly { strategy: string; successRate: number; runs: number }[] {
    return [...this.strategies.entries()]
      .filter(([, r]) => r.runs > 0)
      .map(([strategy, r]) => ({ strategy, successRate: r.successes / r.runs, runs: r.runs }))
      .sort((a, b) => b.successRate - a.successRate);
  }

  snapshot(): LedgerSnapshot {
    return {
      tools: Object.fromEntries(this.tools),
      models: Object.fromEntries(this.models),
      strategies: Object.fromEntries(this.strategies),
      recovery: { ...this.recovery },
    };
  }

  /** Reliability report: tools below a success threshold with enough samples. */
  unreliableTools(minSamples = 3, threshold = 0.5): readonly { tool: string; successRate: number; samples: number }[] {
    return [...this.tools.entries()]
      .filter(([, r]) => {
        const samples = r.successes + r.failures;
        return samples >= minSamples && r.successes / samples < threshold;
      })
      .map(([tool, r]) => {
        const samples = r.successes + r.failures;
        return { tool, successRate: Math.round((r.successes / samples) * 100) / 100, samples };
      })
      .sort((a, b) => a.successRate - b.successRate);
  }
}

// ─── Phase 6.3: adaptive strategy selector over run history ───────────────────

export interface AdaptiveStrategyState {
  /** Strategies tried this run, in order. */
  readonly tried: readonly ExecutionStrategyAttempt[];
  readonly failureCategories: readonly string[];
  readonly replansUsed: number;
}

export interface ExecutionStrategyAttempt {
  readonly strategy: string;
  readonly outcome: "success" | "failure" | "partial";
  readonly at: string;
}

/**
 * Choose the next strategy when the current one keeps failing. Order:
 *   cautious → direct → salvage. Never repeats a failed strategy in the same
 * run; when all are exhausted returns "salvage" (the minimal-spend mode).
 */
export function nextStrategyOnFailure(state: AdaptiveStrategyState): string {
  const failed = new Set(state.tried.filter((t) => t.outcome === "failure").map((t) => t.strategy));
  const order = ["cautious", "direct", "salvage"] as const;
  for (const s of order) {
    if (!failed.has(s)) return s;
  }
  return "salvage";
}
