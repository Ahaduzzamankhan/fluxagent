/**
 * FluxAgent — self-evaluation.
 *
 * After meaningful tasks, evaluate: was the goal achieved? which steps
 * failed? which assumptions were wrong? what evidence supports success?
 *
 * EPISTEMICS: a SelfEvaluation is the agent's OPINION with evidence attached.
 * It is explicitly separated from verified fact (VerificationVerdict2) and
 * never promoted to fact automatically.
 */

import type { AgentState, Observation } from "./state.ts";
import type { EnrichedObservation } from "./observation-engine.ts";
import type { VerificationVerdict2 } from "./verification.ts";

export interface Claim {
  readonly statement: string;
  readonly supported: boolean;
  readonly evidence: readonly string[];
  readonly epistemicType: "fact" | "observation" | "assumption" | "model-generated";
}

export interface FailedStepAnalysis {
  readonly stepId: string;
  readonly title: string;
  readonly reason: string;
  readonly category: string;
}

export interface WrongAssumption {
  readonly assumption: string;
  readonly reality: string;
  readonly evidence: string;
}

export interface SelfEvaluation {
  readonly goalAchieved: boolean;
  readonly confidence: number; // 0..1 — agent's own confidence, NOT objective truth
  readonly claims: readonly Claim[];
  readonly failedSteps: readonly FailedStepAnalysis[];
  readonly wrongAssumptions: readonly WrongAssumption[];
  readonly sideEffects: readonly string[];
  readonly lessons: readonly string[];
  readonly evaluatedAt: string;
  /** Marker that keeps this distinct from verified results. */
  readonly kind: "self-evaluation";
}

export interface EvaluationInput {
  readonly goal: string;
  readonly state: AgentState;
  readonly enrichedObservations: readonly EnrichedObservation[];
  /** Formal verification verdicts (kind=result/state/goal). */
  readonly verdicts: readonly VerificationVerdict2[];
  readonly sideEffects: readonly string[];
}

export class SelfEvaluator {
  evaluate(input: EvaluationInput): SelfEvaluation {
    const { state } = input;
    const claims: Claim[] = [];
    const lessons: string[] = [];
    const wrongAssumptions: WrongAssumption[] = [];

    // 1) Formal verification evidence dominates.
    const goalVerdict = input.verdicts.find((v) => v.kind === "goal");
    if (goalVerdict) {
      claims.push({
        statement: `formal goal verification ${goalVerdict.passed ? "passed" : "failed"}`,
        supported: goalVerdict.passed,
        evidence: goalVerdict.checks.map((c) => `${c.name}: ${c.detail}`),
        epistemicType: "fact",
      });
    }

    // 2) Formal state verification is also fact-backed evidence (pass OR fail —
    // the check result itself is a fact about the world, not an opinion).
    for (const v of input.verdicts.filter((x) => x.kind === "state")) {
      claims.push({
        statement: `state verification for "${v.subject}" ${v.passed ? "passed" : "failed"}: ${v.note}`,
        supported: v.passed,
        evidence: v.checks.map((c) => `${c.name}: ${c.detail}`),
        epistemicType: "fact",
      });
    }

    // 3) Plan-state evidence.
    const plan = state.plan;
    const stepsCompleted = plan?.steps.filter((s) => s.status === "completed").length ?? 0;
    const stepsFailed = plan?.steps.filter((s) => s.status === "failed").length ?? 0;
    const total = plan?.steps.length ?? 0;
    if (plan) {
      claims.push({
        statement: `${stepsCompleted}/${total} plan steps completed`,
        supported: stepsFailed === 0 && stepsCompleted === total,
        evidence: [`plan ${plan.id} rev ${plan.revision}: ${plan.steps.map((s) => s.status).join(", ")}`],
        epistemicType: "observation",
      });
    }

    // 3) Failed-step analysis with diagnosis categories.
    const failedSteps: FailedStepAnalysis[] = (plan?.steps ?? [])
      .filter((s) => s.status === "failed")
      .map((s) => ({
        stepId: s.id,
        title: s.title,
        reason: s.error?.message ?? "unknown",
        category: s.error?.code ?? "unknown",
      }));

    // 4) Assumption audit: tool succeeded but verification/state said otherwise.
    const stateMismatch = input.verdicts.filter((v) => v.kind === "state" && !v.passed);
    for (const v of stateMismatch) {
      wrongAssumptions.push({
        assumption: `tool success implied goal progress (${v.subject})`,
        reality: v.note,
        evidence: v.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`).join("; "),
      });
      lessons.push("distrust tool success without state verification for mutating steps");
    }

    // 5) Evidence from enriched observations.
    const failures = input.enrichedObservations.filter((e) => !e.success);
    for (const f of failures.slice(-3)) {
      claims.push({
        statement: f.summary,
        supported: false,
        evidence: f.evidence.map((e) => `${e.kind}: ${e.detail}`),
        epistemicType: "observation",
      });
    }

    // Confidence: fraction of claims that hold, weighted by epistemic type.
    const weights: Record<Claim["epistemicType"], number> = {
      fact: 1,
      observation: 0.7,
      assumption: 0.3,
      "model-generated": 0.2,
    };
    const totalWeight = claims.reduce((n, c) => n + weights[c.epistemicType], 0);
    const goodWeight = claims.reduce((n, c) => n + (c.supported ? weights[c.epistemicType] : 0), 0);
    const confidence = totalWeight === 0 ? 0 : Math.round((goodWeight / totalWeight) * 100) / 100;

    // Lessons from patterns.
    if (failures.length >= 2) {
      const tools = new Set(failures.map((f) => f.observation.toolName));
      if (tools.size === 1) {
        lessons.push(`tool "${[...tools][0]}" failed repeatedly — prefer an alternative next time`);
      }
    }
    if (stepsFailed > 0 && stepsCompleted === 0) {
      lessons.push("plan produced no completed steps — planning quality issue, revisit decomposition");
    }

    const goalAchieved = (goalVerdict?.passed ?? false) || (stepsFailed === 0 && total > 0 && stepsCompleted === total);

    return {
      goalAchieved,
      confidence,
      claims,
      failedSteps,
      wrongAssumptions,
      sideEffects: input.sideEffects,
      lessons,
      evaluatedAt: new Date().toISOString(),
      kind: "self-evaluation",
    };
  }
}

// ─── Execution learning ───────────────────────────────────────────────────────

export interface ExecutionLesson {
  readonly condition: string;
  readonly preference: string;
  readonly fromTask?: string;
  readonly createdAt: string;
}

/**
 * Extracts transferable lessons from task outcomes into structured memory —
 * NEVER self-modifying code. Lessons inform future decision context only.
 */
export class ExecutionLearner {
  private readonly lessons: ExecutionLesson[] = [];

  learnFrom(evaluation: SelfEvaluation, taskId?: string): readonly ExecutionLesson[] {
    const out: ExecutionLesson[] = [];
    for (const lesson of evaluation.lessons) {
      const l: ExecutionLesson = {
        condition: `when similar to: ${evaluation.failedSteps.map((f) => f.category).join("/") || evaluation.goalAchieved ? "successful-completion" : "failure"}`,
        preference: lesson,
        ...(taskId ? { fromTask: taskId } : {}),
        createdAt: new Date().toISOString(),
      };
      out.push(l);
      this.lessons.push(l);
    }
    return out;
  }

  /** Applicable lessons for a new goal (bounded). */
  applicable(goal: string, limit = 5): readonly ExecutionLesson[] {
    const g = goal.toLowerCase();
    return this.lessons
      .filter((l) => l.preference.length > 0)
      .slice(-limit)
      .concat(this.lessons.filter((l) => g.split(/\s+/).some((w) => w.length > 3 && l.condition.toLowerCase().includes(w))).slice(0, 2));
  }

  all(): readonly ExecutionLesson[] {
    return [...this.lessons];
  }
}
