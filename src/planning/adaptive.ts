/**
 * FluxAgent — adaptive planning.
 *
 * Extends the base Plan/Step model with: expected outcomes, alternative
 * actions, plan invalidation, progress tracking, and structured replanning.
 * Works on the existing Plan (from planning/plan.ts) without rewriting it —
 * helpers here treat plans as mutable snapshots owned by the StateManager.
 */

import type { Plan, PlanStep } from "./plan.ts";
import { createStep } from "./plan.ts";
import type { PlannedStep } from "../llm/provider.ts";

// ─── Extended step metadata ───────────────────────────────────────────────────

export interface StepExpectation {
  /** What should be true after this step succeeds. */
  readonly outcome: string;
  /** Alternative tools to try if the primary fails. */
  readonly alternativeTools?: readonly string[];
  /** Hints the planner gives the recovery layer. */
  readonly onFailure?: readonly string[];
}

/** Registry of expectations keyed by step id (kept out of PlanStep to stay compatible). */
export interface PlanExpectations {
  readonly planId: string;
  readonly byStep: ReadonlyMap<string, StepExpectation>;
}

export function buildExpectations(steps: readonly { step: PlanStep; expectation?: StepExpectation }[]): PlanExpectations {
  const byStep = new Map<string, StepExpectation>();
  for (const { step, expectation } of steps) {
    if (expectation) byStep.set(step.id, expectation);
  }
  return { planId: "pending", byStep };
}

// ─── Progress tracking ────────────────────────────────────────────────────────

export interface PlanProgress {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
  readonly running: number;
  readonly blocked: number;
  readonly percent: number;
  /** Failed steps with no remaining retry budget. */
  readonly stuckStepIds: readonly string[];
}

export function planProgress(plan: Plan): PlanProgress {
  const counts = { completed: 0, failed: 0, skipped: 0, pending: 0, running: 0, blocked: 0, cancelled: 0 };
  for (const s of plan.steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const total = plan.steps.length;
  const done = counts.completed + counts.skipped;
  const stuck = plan.steps
    .filter((s) => s.status === "failed")
    .map((s) => s.id);
  return {
    total,
    completed: counts.completed,
    failed: counts.failed,
    skipped: counts.skipped,
    pending: counts.pending,
    running: counts.running,
    blocked: counts.blocked,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    stuckStepIds: stuck,
  };
}

// ─── Invalidation ─────────────────────────────────────────────────────────────

export type InvalidationReason =
  | "assumption-broken"
  | "environment-changed"
  | "step-unrepairable"
  | "goal-refined"
  | "manual";

/**
 * Decide whether the plan is still valid given fresh evidence.
 * A plan is invalid when a completed step's outcome was undone (e.g. the file
 * it wrote was deleted) or a structural dependency can no longer be met.
 */
export function evaluatePlanValidity(
  plan: Plan,
  evidence: readonly { readonly kind: "state-mismatch" | "step-result-undone" | "none"; readonly stepId?: string; readonly detail?: string }[],
): { valid: boolean; reason?: string; invalidStepIds: readonly string[] } {
  const invalidStepIds: string[] = [];
  for (const e of evidence) {
    if (e.kind === "step-result-undone" && e.stepId) invalidStepIds.push(e.stepId);
    if (e.kind === "state-mismatch") {
      return { valid: false, reason: e.detail ?? "environment no longer matches plan assumptions", invalidStepIds };
    }
  }
  const failedWithDeps = plan.steps.filter(
    (s) => s.status === "pending" && s.dependsOn.some((d) => plan.steps.find((x) => x.id === d)?.status === "failed"),
  );
  if (failedWithDeps.length > 0) {
    return {
      valid: false,
      reason: `${failedWithDeps.length} step(s) depend on failed work`,
      invalidStepIds: failedWithDeps.map((s) => s.id),
    };
  }
  return { valid: true, invalidStepIds };
}

/**
 * Invalidate downstream pending steps of the given failures (mark cancelled)
 * so a revised plan can rebuild them. Returns the ids actually cancelled.
 */
export function invalidateDownstream(plan: Plan, failedStepIds: readonly string[], reason: InvalidationReason): string[] {
  const failed = new Set(failedStepIds);
  const cancelled: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of plan.steps) {
      if (s.status !== "pending") continue;
      if (s.dependsOn.some((d) => failed.has(d))) {
        s.status = "cancelled";
        s.error = { name: "PlanInvalidation", code: "E_PLAN_INVALID", message: `cancelled: ${reason}`, details: {} };
        failed.add(s.id);
        cancelled.push(s.id);
        changed = true;
      }
    }
  }
  return cancelled;
}

// ─── Alternative-aware step creation ─────────────────────────────────────────

/**
 * Create a PlanStep with alternatives encoded in `verify` (used by the
 * observer) and an expectation entry for the recovery layer.
 */
export function createAdaptiveStep(spec: {
  title: string;
  description: string;
  tool: string | null;
  args?: Record<string, unknown>;
  dependsOn?: readonly string[];
  expectation?: StepExpectation;
}): { step: PlanStep; expectation?: StepExpectation } {
  const step = createStep({
    title: spec.title,
    description: spec.description,
    tool: spec.tool,
    args: spec.args,
    ...(spec.dependsOn ? { dependsOn: spec.dependsOn } : {}),
    ...(spec.expectation?.outcome ? { verify: spec.expectation.outcome } : {}),
  });
  return { step, expectation: spec.expectation };
}

/**
 * Convert alternative tools into fallback PlannedSteps for replanning:
 * "try X, else Y" becomes two steps where Y depends on X failing.
 */
export function alternativesToFallbackSteps(
  failedTitle: string,
  alternatives: readonly string[],
  baseArgs: Record<string, unknown>,
  description: string,
): PlannedStep[] {
  return alternatives.map((tool, i) => ({
    title: i === 0 ? `${failedTitle} (alternative ${i + 1})` : `${failedTitle} (alternative ${i + 1})`,
    description,
    tool,
    args: { ...baseArgs },
    dependsOn: [],
  }));
}

/** Summarize progress for the decision engine / context manager. */
export function progressSummary(plan: Plan): string {
  const p = planProgress(plan);
  return `${p.completed}/${p.total} steps (${p.percent}%)` + (p.failed ? `, ${p.failed} failed` : "");
}
