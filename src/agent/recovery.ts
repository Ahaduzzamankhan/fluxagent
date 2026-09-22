/**
 * FluxAgent — recovery.
 *
 * Classifies failures, decides retry vs replan vs abort, and enforces hard
 * caps so loops terminate. Pure decision logic — the executor applies it.
 */

import type { EventBus } from "../events/event-bus.ts";
import { makeEvent } from "../events/events.ts";
import type { Logger } from "../utils/logger.ts";
import type { PlanStep } from "../planning/plan.ts";
import type { Observation } from "./state.ts";

export type FailureClass =
  | "transient" // retry makes sense (timeout, transient IO)
  | "permission" // needs approval, not retry
  | "invalid-args" // replan with corrected arguments
  | "not-found" // replan (create first, alternative path)
  | "permanent" // do not retry
  | "cancelled";

export interface RecoveryDecision {
  readonly action: "retry" | "replan" | "abort" | "skip";
  readonly reason: string;
  /** Backoff before retry in ms (0 = immediate). */
  readonly retryDelayMs?: number;
  /** Suggested corrections for replanning (for the LLM). */
  readonly replanHints?: readonly string[];
}

export interface RecoveryPolicy {
  /** Max retries per step (default 2). */
  readonly maxRetriesPerStep?: number;
  /** Max replans per run (default 2). */
  readonly maxReplansPerRun?: number;
  /** Base delay between retries (default 500ms, exponential x2). */
  readonly retryBaseDelayMs?: number;
}

export const DEFAULT_RECOVERY_POLICY: Required<RecoveryPolicy> = {
  maxRetriesPerStep: 2,
  maxReplansPerRun: 2,
  retryBaseDelayMs: 500,
};

export interface RecoveryContext {
  readonly step: PlanStep;
  readonly observation: Observation;
  readonly replansSoFar: number;
  readonly goal: string;
}

export class RecoveryManager {
  private readonly policy: Required<RecoveryPolicy>;
  private readonly eventBus?: EventBus;
  private readonly logger?: Logger;

  constructor(options: { policy?: RecoveryPolicy; eventBus?: EventBus; logger?: Logger } = {}) {
    this.policy = { ...DEFAULT_RECOVERY_POLICY, ...options.policy };
    this.eventBus = options.eventBus;
    this.logger = options.logger;
  }

  classify(obs: Observation): FailureClass {
    const code = obs.error?.code ?? "";
    if (obs.toolName === "__cancelled__" || code === "E_CANCELLED") return "cancelled";
    if (code === "E_PERMISSION_DENIED" || code === "E_APPROVAL_REJECTED" || code === "E_APPROVAL_TIMEOUT") {
      return "permission";
    }
    if (code === "E_TOOL_ARGUMENTS_INVALID" || code === "E_SCHEMA_MISMATCH" || code === "E_VALIDATION") {
      return "invalid-args";
    }
    if (code === "E_STEP_NOT_FOUND" || obs.error?.message?.toLowerCase().includes("not found")) {
      return "not-found";
    }
    if (code === "E_STEP_TIMEOUT" || code === "E_LLM_RATE_LIMITED" || code === "E_INTERNAL") {
      return "transient";
    }
    return "permanent";
  }

  /** Decide what to do after a failed observation. Pure. */
  decide(ctx: RecoveryContext): RecoveryDecision {
    const cls = this.classify(ctx.observation);

    if (cls === "cancelled") {
      return { action: "abort", reason: "run cancelled" };
    }

    if (cls === "permission") {
      return {
        action: "abort",
        reason: `permission denied for "${ctx.step.tool ?? "?"}" — ask the user or replan without this action`,
      };
    }

    if (cls === "invalid-args") {
      return {
        action: "replan",
        reason: "arguments invalid — replan with corrected arguments",
        replanHints: [`previous args rejected: ${ctx.observation.error?.hint ?? ctx.observation.error?.message ?? "?"}`],
      };
    }

    if (cls === "not-found") {
      return {
        action: "replan",
        reason: "target not found — replan to create it or use an alternative",
        replanHints: [`not found: ${ctx.observation.error?.message ?? "?"}`],
      };
    }

    if (cls === "transient") {
      if (ctx.step.retryCount < this.policy.maxRetriesPerStep) {
        const delay = this.policy.retryBaseDelayMs * Math.pow(2, ctx.step.retryCount);
        return {
          action: "retry",
          reason: `transient failure (attempt ${ctx.step.retryCount + 1}/${this.policy.maxRetriesPerStep + 1})`,
          retryDelayMs: delay,
        };
      }
      return { action: "replan", reason: "retries exhausted on transient failure", replanHints: ["step kept failing after retries"] };
    }

    // permanent
    return { action: "abort", reason: `permanent failure: ${ctx.observation.error?.message ?? "unknown"}` };
  }

  /** Apply a decision, emitting events; returns delay to wait before retry. */
  async apply(
    decision: RecoveryDecision,
    info: { sessionId: string; runId?: string; stepId: string },
  ): Promise<void> {
    if (decision.action === "retry" || decision.action === "replan") {
      this.eventBus?.emitSync(
        makeEvent(info.sessionId, "agent.recovered", {
          stepId: info.stepId,
          strategy: decision.action,
          reason: decision.reason,
        }, info.runId),
      );
      this.logger?.info("recovery action", { action: decision.action, reason: decision.reason });
    }
  }

  get maxReplans(): number {
    return this.policy.maxReplansPerRun;
  }
}
