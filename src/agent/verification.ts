/**
 * FluxAgent — verification engine.
 *
 * Distinguishes TOOL success ("the command ran") from TASK success ("the
 * requested state actually changed"). Layered:
 *
 *   1. result verification   — output shape/flags
 *   2. state verification    — custom predicates against the world
 *   3. goal verification     — completion criteria over the whole run
 *
 * A verdict is EVIDENCE, never blind trust: every pass/fail carries the
 * checks that produced it.
 */

import type { Observation } from "./state.ts";
import type { Plan, PlanStep } from "../planning/plan.ts";

export type VerificationKind = "result" | "state" | "goal";

export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface VerificationVerdict2 {
  readonly kind: VerificationKind;
  readonly subject: string; // stepId / goal
  readonly passed: boolean;
  readonly checks: readonly VerificationCheck[];
  readonly note: string;
  readonly at: string;
}

/** A state predicate runs against the live world (via controllers), not the model. */
export type StatePredicate = () => Promise<{ pass: boolean; detail: string }>;

export interface CompletionCriteria {
  /** All must pass for the goal to be considered achieved. */
  readonly requiredChecks: readonly {
    readonly name: string;
    /** Observation-based check. */
    readonly fromObservations?: (obs: readonly Observation[]) => { pass: boolean; detail: string };
    /** World-state check (runs a controller call). */
    readonly fromState?: StatePredicate;
  }[];
  /** Minimum fraction of plan steps that must complete (0..1). */
  readonly minCompletedFraction?: number;
}

// ─── Result verification (pure, observation-based) ────────────────────────────

export interface ResultRule {
  readonly name: string;
  /** Return true when the output satisfies the rule. */
  check: (output: unknown) => { pass: boolean; detail: string };
}

/** Common reusable result rules. */
export const resultRules = {
  flagTrue: (flag: string): ResultRule => ({
    name: `output.${flag} === true`,
    check: (out) => {
      const v = (out as Record<string, unknown> | undefined)?.[flag];
      return { pass: v === true, detail: `${flag}=${String(v)}` };
    },
  }),
  nonEmpty: (field: string): ResultRule => ({
    name: `output.${field} non-empty`,
    check: (out) => {
      const v = (out as Record<string, unknown> | undefined)?.[field];
      const pass = typeof v === "string" ? v.length > 0 : v !== undefined && v !== null;
      return { pass, detail: `${field} present: ${pass}` };
    },
  }),
  countAtLeast: (field: string, min: number): ResultRule => ({
    name: `output.${field} >= ${min}`,
    check: (out) => {
      const v = (out as Record<string, unknown> | undefined)?.[field];
      const n = typeof v === "number" ? v : Array.isArray(v) ? v.length : 0;
      return { pass: n >= min, detail: `${field}=${n}` };
    },
  }),
  exitCodeZero: (): ResultRule => ({
    name: "exitCode === 0",
    check: (out) => {
      const code = (out as Record<string, unknown> | undefined)?.exitCode;
      return { pass: code === 0, detail: `exitCode=${String(code)}` };
    },
  }),
} as const;

/**
 * Verify a tool result observation against rules.
 * kind="result": did the tool DO what it claimed?
 */
export function verifyResult(obs: Observation, rules: readonly ResultRule[]): VerificationVerdict2 {
  const checks: VerificationCheck[] = [];
  if (!obs.ok) {
    checks.push({ name: "tool-reported-success", passed: false, detail: obs.error?.message ?? "tool failed" });
  } else {
    checks.push({ name: "tool-reported-success", passed: true, detail: "observation.ok" });
    for (const rule of rules) {
      const { pass, detail } = rule.check(obs.output);
      checks.push({ name: rule.name, passed: pass, detail });
    }
  }
  const passed = checks.every((c) => c.passed);
  return {
    kind: "result",
    subject: obs.stepId ?? obs.callId,
    passed,
    checks,
    note: passed ? "result verification passed" : `failed: ${checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}`,
    at: new Date().toISOString(),
  };
}

// ─── State verification (world-touching) ─────────────────────────────────────

/** Run state predicates; each predicate is responsible for its own error handling. */
export async function verifyState(
  subject: string,
  predicates: readonly { name: string; predicate: StatePredicate }[],
): Promise<VerificationVerdict2> {
  const checks: VerificationCheck[] = [];
  for (const { name, predicate } of predicates) {
    try {
      const { pass, detail } = await predicate();
      checks.push({ name, passed: pass, detail });
    } catch (e) {
      checks.push({
        name,
        passed: false,
        detail: `predicate threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  const passed = checks.length > 0 && checks.every((c) => c.passed);
  return {
    kind: "state",
    subject,
    passed,
    checks,
    note: passed ? "state verification passed" : `state mismatch: ${checks.filter((c) => !c.passed).map((c) => c.detail).join("; ")}`,
    at: new Date().toISOString(),
  };
}

// ─── Goal verification (completion criteria) ─────────────────────────────────

/**
 * Verify the GOAL against completion criteria + plan state.
 * kind="goal": is the user's objective actually achieved?
 */
export async function verifyGoal(
  goal: string,
  plan: Plan | null,
  observations: readonly Observation[],
  criteria: CompletionCriteria,
): Promise<VerificationVerdict2> {
  const checks: VerificationCheck[] = [];

  if (criteria.minCompletedFraction !== undefined && plan) {
    const completed = plan.steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
    const fraction = plan.steps.length === 0 ? 0 : completed / plan.steps.length;
    checks.push({
      name: "min-completed-fraction",
      passed: fraction >= criteria.minCompletedFraction,
      detail: `${completed}/${plan.steps.length} = ${Math.round(fraction * 100)}% (min ${Math.round(criteria.minCompletedFraction * 100)}%)`,
    });
  }

  for (const check of criteria.requiredChecks) {
    if (check.fromObservations) {
      const { pass, detail } = check.fromObservations(observations);
      checks.push({ name: check.name, passed: pass, detail });
    } else if (check.fromState) {
      try {
        const { pass, detail } = await check.fromState();
        checks.push({ name: check.name, passed: pass, detail });
      } catch (e) {
        checks.push({ name: check.name, passed: false, detail: `predicate threw: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  const passed = checks.length > 0 && checks.every((c) => c.passed);
  return {
    kind: "goal",
    subject: goal,
    passed,
    checks,
    note: passed ? "goal criteria satisfied" : `goal not met: ${checks.filter((c) => !c.passed).map((c) => c.detail).join("; ")}`,
    at: new Date().toISOString(),
  };
}

/** Default goal criteria when the planner supplied none: plan fully completed. */
export function defaultCompletionCriteria(plan: Plan | null): CompletionCriteria {
  return {
    requiredChecks: [
      {
        name: "no-failed-steps",
        fromObservations: () => {
          const failed = plan?.steps.filter((s) => s.status === "failed").length ?? 0;
          return { pass: failed === 0, detail: `${failed} failed steps` };
        },
      },
    ],
    minCompletedFraction: plan ? 1 : undefined,
  };
}

// Bridge to the simpler Observer.verify verdict type used by the executor.
export function toSimpleVerdict(v: VerificationVerdict2): { pass: boolean; note: string } {
  return { pass: v.passed, note: v.note };
}
