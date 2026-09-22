/**
 * FluxAgent — recovery engine (v2).
 *
 * Strategy-based recovery driven by structured diagnosis:
 *
 *   ERROR → CLASSIFY (diagnosis.ts) → DIAGNOSE → SELECT STRATEGY → LIMIT → ACT
 *
 * Strategies are pluggable; defaults map 1:1 to the recommendations in
 * diagnosis.ts. Hard caps on retries/replans/history guarantee termination.
 * Security note: recovery NEVER bypasses permissions — "request-approval"
 * routes back through the approval flow, nothing else.
 */

import type { EventBus } from "../events/event-bus.ts";
import { makeEvent } from "../events/events.ts";
import type { Logger } from "../utils/logger.ts";
import type { PlanStep } from "../planning/plan.ts";
import type { Observation } from "./state.ts";
import { diagnose, type Diagnosis, type RecoveryRecommendation } from "./diagnosis.ts";

export interface RecoveryStrategy {
  readonly name: RecoveryRecommendation;
  /** Human-readable description of what this strategy does. */
  readonly description: string;
  /** Whether executing this strategy consumes a retry attempt. */
  readonly consumesRetry: boolean;
}

export interface RecoveryAttempt {
  readonly at: string;
  readonly stepId: string;
  readonly toolName: string;
  readonly category: string;
  readonly recommendation: string;
  readonly strategy: string;
  readonly attemptNumber: number;
}

export interface RecoveryOutcome {
  readonly action: "retry" | "replan" | "request-approval" | "abort" | "alternative-tool";
  readonly reason: string;
  readonly delayMs: number;
  /** Strategy applied; useful for traceability. */
  readonly strategy: RecoveryStrategy;
  readonly diagnosis: Diagnosis;
}

export interface RecoveryEngineOptions {
  readonly maxRetriesPerStep?: number;
  readonly maxRecoveryHistoryPerRun?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly eventBus?: EventBus;
  readonly logger?: Logger;
}

const DEFAULTS = {
  maxRetriesPerStep: 2,
  maxRecoveryHistoryPerRun: 100,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 8000,
} as const;

/** Strategy metadata per recommendation (consumesRetry mirrors safety). */
const STRATEGIES: Readonly<Record<RecoveryRecommendation, RecoveryStrategy>> = {
  "repair-args": { name: "repair-args", description: "replan the step with corrected arguments", consumesRetry: false },
  "request-approval": { name: "request-approval", description: "route back through the permission/approval flow", consumesRetry: false },
  retry: { name: "retry", description: "immediate retry", consumesRetry: true },
  "retry-with-backoff": { name: "retry-with-backoff", description: "retry after exponential backoff", consumesRetry: true },
  "check-connectivity": { name: "check-connectivity", description: "verify network then retry", consumesRetry: true },
  "select-alternative-tool": { name: "select-alternative-tool", description: "try a registered alternative tool", consumesRetry: false },
  "re-observe": { name: "re-observe", description: "gather fresh observations before deciding", consumesRetry: false },
  "satisfy-dependency": { name: "satisfy-dependency", description: "create/repair the missing prerequisite", consumesRetry: false },
  replan: { name: "replan", description: "revise the plan", consumesRetry: false },
  abort: { name: "abort", description: "stop and report", consumesRetry: false },
  "escalate-to-user": { name: "escalate-to-user", description: "stop and ask the user", consumesRetry: false },
};

export class RecoveryEngine {
  private readonly opts: Required<RecoveryEngineOptions>;
  private readonly history: RecoveryAttempt[] = [];
  private readonly retriesByStep = new Map<string, number>();

  constructor(options: RecoveryEngineOptions = {}) {
    this.opts = { ...DEFAULTS, ...options } as Required<RecoveryEngineOptions>;
  }

  /**
   * Diagnose a failed step and select the recovery outcome.
   * Enforces per-step retry limits and overall history bounds.
   */
  recover(step: PlanStep, observation: Observation): RecoveryOutcome {
    const d = diagnose(observation);
    const retries = this.retriesByStep.get(step.id) ?? 0;
    const strategy = STRATEGIES[d.recommendation];

    this.record({
      stepId: step.id,
      toolName: observation.toolName,
      category: d.category,
      recommendation: d.recommendation,
      strategy: strategy.name,
      attemptNumber: retries + 1,
    });

    // Hard limits first — no infinite loops, ever.
    if (strategy.consumesRetry && retries >= this.opts.maxRetriesPerStep) {
      return this.outcome(step, d, "replan", 0,
        `retry limit reached (${this.opts.maxRetriesPerStep}) for "${step.title}"`);
    }

    switch (d.recommendation) {
      case "request-approval":
        return this.outcome(step, d, "request-approval", 0,
          "permission required — returning to approval flow");
      case "abort":
      case "escalate-to-user":
        return this.outcome(step, d, "abort", 0, d.rootCause);
      case "repair-args":
      case "satisfy-dependency":
      case "select-alternative-tool":
        return this.outcome(step, d, "alternative-tool", 0,
          `${strategy.description}: ${d.rootCause}`);
      case "re-observe":
        return this.outcome(step, d, "retry", 0,
          `re-observe then retry: ${d.rootCause}`);
      case "replan":
        return this.outcome(step, d, "replan", 0, d.rootCause);
      case "retry":
      case "retry-with-backoff":
      case "check-connectivity": {
        const delay = Math.min(
          this.opts.retryBaseDelayMs * Math.pow(2, retries),
          this.opts.retryMaxDelayMs,
        );
        this.bumpRetry(step.id);
        return this.outcome(step, d, "retry", delay,
          `retry ${retries + 1}/${this.opts.maxRetriesPerStep} (${strategy.description})`);
      }
      default:
        return this.outcome(step, d, "replan", 0, `unhandled recommendation: ${d.recommendation}`);
    }
  }

  /** Called when a step eventually succeeds — clears its retry budget. */
  resetStep(stepId: string): void {
    this.retriesByStep.delete(stepId);
  }

  getRecoveryHistory(limit = 20): readonly RecoveryAttempt[] {
    return this.history.slice(-limit);
  }

  get totalAttempts(): number {
    return this.history.length;
  }

  private bumpRetry(stepId: string): void {
    this.retriesByStep.set(stepId, (this.retriesByStep.get(stepId) ?? 0) + 1);
  }

  private record(a: Omit<RecoveryAttempt, "at">): void {
    this.history.push({ at: new Date().toISOString(), ...a });
    if (this.history.length > this.opts.maxRecoveryHistoryPerRun) {
      this.history.splice(0, this.history.length - this.opts.maxRecoveryHistoryPerRun);
    }
    this.opts.eventBus?.emitSync(
      makeEvent("runtime", "agent.recovered", { strategy: a.strategy, stepId: a.stepId }),
    );
    this.opts.logger?.info("recovery selected", {
      step: a.stepId,
      category: a.category,
      strategy: a.strategy,
    });
  }

  private outcome(
    step: PlanStep,
    d: Diagnosis,
    action: RecoveryOutcome["action"],
    delayMs: number,
    reason: string,
  ): RecoveryOutcome {
    return { action, reason, delayMs, strategy: STRATEGIES[d.recommendation], diagnosis: d };
  }
}

export { STRATEGIES as RECOVERY_STRATEGIES };
