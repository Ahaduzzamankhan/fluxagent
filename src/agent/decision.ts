/**
 * FluxAgent — decision engine.
 *
 * The structured layer between planning and execution. A Decision records not
 * just WHAT to do but WHY, with what risk, expecting what outcome, and needing
 * which permission. Model-reported confidence is captured verbatim — it is
 * never treated as objective truth.
 *
 * `HeuristicDecisionEngine` produces decisions from plan + observations with
 * no model call (deterministic, testable). An LLM-backed engine can implement
 * the same `DecisionEngine` interface later.
 */

import type { Plan, PlanStep } from "../planning/plan.ts";
import { dependenciesSatisfied, anyDependencyFailed } from "../planning/plan.ts";
import type { Observation } from "../agent/state.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { PermissionLevel } from "../tools/permissions.ts";
import { diagnose } from "./diagnosis.ts";

export type DecisionAction =
  | "execute-step"
  | "replan"
  | "wait-approval"
  | "skip-step"
  | "abort"
  | "finish";

export type DecisionRisk = "none" | "low" | "medium" | "high";

export interface Decision {
  readonly id: string;
  readonly at: string;
  readonly action: DecisionAction;
  /** Step id when action === "execute-step" | "skip-step". */
  readonly stepId?: string;
  /** Tool the decision targets. */
  readonly target?: string;
  readonly reason: string;
  readonly expectedOutcome: string;
  /** Model- or heuristic-reported confidence 0..1 — informational only. */
  readonly confidence: number;
  readonly risk: DecisionRisk;
  readonly requiredPermission?: PermissionLevel;
  /** Derived from diagnosis when the decision follows a failure. */
  readonly diagnosisCategory?: string;
}

export interface DecisionInput {
  readonly goal: string;
  readonly plan: Plan;
  readonly observations: readonly Observation[];
  readonly replansUsed: number;
  readonly maxReplans: number;
  readonly stepsExecuted: number;
  readonly maxSteps: number;
}

export interface DecisionEngine {
  decide(input: DecisionInput): Decision;
}

function makeDecision(partial: Omit<Decision, "id" | "at">): Decision {
  return {
    id: `dec_${Math.random().toString(36).slice(2, 12)}`,
    at: new Date().toISOString(),
    ...partial,
  };
}

/**
 * Deterministic decision policy over plan state. No model calls.
 *
 * Priority order:
 *   1. step budget exhausted → abort
 *   2. plan complete → finish
 *   3. last observation failed → recovery-oriented decision
 *   4. next runnable step → execute it
 *   5. steps blocked/failed with no runnable work → replan (if budget) or abort
 */
export class HeuristicDecisionEngine implements DecisionEngine {
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  decide(input: DecisionInput): Decision {
    const { plan } = input;

    if (input.stepsExecuted >= input.maxSteps) {
      return makeDecision({
        action: "abort",
        reason: `step budget exhausted (${input.maxSteps})`,
        expectedOutcome: "run stops with partial results",
        confidence: 1,
        risk: "none",
      });
    }

    const pending = plan.steps.filter((s) => s.status === "pending");
    const failed = plan.steps.filter((s) => s.status === "failed");
    if (pending.length === 0 && failed.length === 0) {
      return makeDecision({
        action: "finish",
        reason: "all plan steps are in a terminal state",
        expectedOutcome: "goal considered handled",
        confidence: 1,
        risk: "none",
      });
    }

    // Reaction to the most recent failed observation.
    const lastFailure = [...input.observations].reverse().find((o) => !o.ok);
    const lastFailedStep = lastFailure
      ? plan.steps.find((s) => s.id === lastFailure.stepId)
      : undefined;

    if (lastFailure && lastFailedStep && lastFailedStep.status === "failed") {
      const d = diagnose(lastFailure);
      if (d.recommendation === "request-approval") {
        return makeDecision({
          action: "wait-approval",
          stepId: lastFailedStep.id,
          target: lastFailedStep.tool ?? undefined,
          reason: `permission problem: ${d.rootCause}`,
          expectedOutcome: "user grants or denies the blocked capability",
          confidence: 0.9,
          risk: "none",
          requiredPermission: lastFailedStep.tool
            ? this.registry.get(lastFailedStep.tool)?.metadata.permissionLevel
            : undefined,
          diagnosisCategory: d.category,
        });
      }
      if (input.replansUsed < input.maxReplans) {
        return makeDecision({
          action: "replan",
          reason: `failure requires plan change: ${d.rootCause}`,
          expectedOutcome: "revised plan avoiding the failure mode",
          confidence: 0.7,
          risk: "low",
          diagnosisCategory: d.category,
        });
      }
      return makeDecision({
        action: "abort",
        reason: `unrecoverable failure and replan budget exhausted: ${d.rootCause}`,
        expectedOutcome: "run stops with failure report",
        confidence: 0.9,
        risk: "none",
        diagnosisCategory: d.category,
      });
    }

    // Normal forward progress.
    const next = plan.steps.find(
      (s) => s.status === "pending" && dependenciesSatisfied(s, plan.steps),
    );
    if (next) {
      const toolMeta = next.tool ? this.registry.get(next.tool)?.metadata : undefined;
      if (next.tool && !toolMeta) {
        return makeDecision({
          action: "skip-step",
          stepId: next.id,
          target: next.tool,
          reason: `step references unregistered tool "${next.tool}"`,
          expectedOutcome: "step marked failed; planner can recover",
          confidence: 1,
          risk: "none",
        });
      }
      return makeDecision({
        action: "execute-step",
        stepId: next.id,
        target: next.tool ?? undefined,
        reason: `next pending step with satisfied dependencies: ${next.title}`,
        expectedOutcome: next.verify ?? `step "${next.title}" completes`,
        confidence: 0.8,
        risk: riskFor(toolMeta?.permissionLevel),
        requiredPermission: toolMeta?.permissionLevel,
      });
    }

    // Nothing runnable: blocked or dependency-failed steps remain.
    const depFailed = plan.steps.find((s) => s.status === "pending" && anyDependencyFailed(s, plan.steps));
    if (depFailed) {
      return input.replansUsed < input.maxReplans
        ? makeDecision({
            action: "replan",
            reason: `step "${depFailed.title}" depends on a failed step`,
            expectedOutcome: "plan revised to repair or bypass the dependency",
            confidence: 0.8,
            risk: "low",
          })
        : makeDecision({
            action: "abort",
            reason: `dependency failure with no replan budget left: ${depFailed.title}`,
            expectedOutcome: "run stops with failure report",
            confidence: 0.9,
            risk: "none",
          });
    }

    return makeDecision({
      action: input.replansUsed < input.maxReplans ? "replan" : "abort",
      reason: "no runnable steps (all remaining are blocked)",
      expectedOutcome: "plan revised or run stopped",
      confidence: 0.7,
      risk: "none",
    });
  }
}

/** Risk band from permission level — permissions are the safety signal. */
function riskFor(level: PermissionLevel | undefined): DecisionRisk {
  switch (level) {
    case "READ_ONLY": return "low";
    case "SAFE_WRITE": return "low";
    case "USER_CONFIRMATION": return "medium";
    case "PRIVILEGED": return "high";
    default: return "none";
  }
}

export { makeDecision as makeStructuredDecision };
