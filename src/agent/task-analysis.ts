/**
 * FluxAgent — task analysis & complexity estimation (Phase 6.1).
 *
 * Produces a structured TaskAnalysis that the decision engine and model
 * router consume: estimated complexity, task type, required reasoning level,
 * approximate context size, risk hints. Deterministic heuristics — no model
 * call needed — so it is testable and cheap. An LLM-backed analyzer can
 * implement the same interface later.
 */

import type { Plan } from "../planning/plan.ts";

export type TaskType =
  | "filesystem"
  | "coding"
  | "reasoning"
  | "summarization"
  | "vision"
  | "retrieval"
  | "automation"
  | "mixed"
  | "unknown";

export type ReasoningLevel = "minimal" | "moderate" | "deep";

export interface TaskAnalysis {
  readonly goal: string;
  readonly type: TaskType;
  readonly complexity: "simple" | "moderate" | "complex";
  /** 0..1 heuristic estimate — metadata, not truth. */
  readonly estimatedComplexity: number;
  readonly reasoningLevel: ReasoningLevel;
  /** Rough input size for context/model selection. */
  readonly approxInputChars: number;
  /** Tools the plan/goal implies (by prefix). */
  readonly impliedToolPrefixes: readonly string[];
  /** Hints that raised the estimate — kept for explainability. */
  readonly signals: readonly string[];
}

export interface TaskAnalysisOptions {
  readonly plan?: Plan | null;
  readonly observationsCount?: number;
  /** Task priority can raise strategy aggressiveness. */
  readonly priority?: "low" | "normal" | "high" | "critical";
  /** Previous failures on this task bias complexity upward. */
  readonly previousFailures?: number;
}

// Goal keyword → task type mapping (deterministic, ordered).
const TYPE_SIGNALS: readonly { type: TaskType; pattern: RegExp; signal: string }[] = [
  { type: "vision", pattern: /\b(screenshot|screen|image|picture|ocr|read text from)\b/i, signal: "vision keywords" },
  { type: "coding", pattern: /\b(code|implement|refactor|compile|build|test|typescript|python|program|script)\b/i, signal: "coding keywords" },
  { type: "filesystem", pattern: /\b(file|folder|directory|move|copy|rename|organize|delete|create)\b/i, signal: "filesystem keywords" },
  { type: "summarization", pattern: /\b(summarize|summary|digest|tl;?dr|condense)\b/i, signal: "summarization keywords" },
  { type: "retrieval", pattern: /\b(find|search|look up|list|locate|which|where)\b/i, signal: "retrieval keywords" },
  { type: "automation", pattern: /\b(open|launch|install|click|type|press|start|close|window)\b/i, signal: "automation keywords" },
  { type: "reasoning", pattern: /\b(analyze|compare|evaluate|decide|plan|explain|why|trade-?offs?)\b/i, signal: "reasoning keywords" },
];

export class HeuristicTaskAnalyzer {
  analyze(goal: string, options: TaskAnalysisOptions = {}): TaskAnalysis {
    const signals: string[] = [];

    // 1) Task type: strongest matching signal wins; multiple distinct
    // matches → mixed (retrieval keywords are weak — they appear in most
    // goals — so they never trigger "mixed" on their own).
    const WEAK_TYPES: ReadonlySet<string> = new Set(["retrieval"]);
    const matched = TYPE_SIGNALS.filter((s) => s.pattern.test(goal));
    const strong = matched.filter((m) => !WEAK_TYPES.has(m.type));
    const effective = strong.length > 0 ? strong : matched;
    let type: TaskType = effective.length > 0 ? effective[0]!.type : "unknown";
    if (effective.length > 1 && effective[0]!.type !== effective[1]!.type) {
      type = "mixed";
      signals.push(`multiple domains: ${effective.map((m) => m.type).join(", ")}`);
    }
    if (matched.length > 0) signals.push(matched[0]!.signal);

    // 2) Complexity factors.
    let score = 0.1;

    const words = goal.trim().split(/\s+/).length;
    if (words > 8) { score += 0.1; signals.push(`goal length (${words} words)`); }
    if (words > 25) { score += 0.1; signals.push("very long goal"); }

    // Conjunctions / sequencing imply multiple steps.
    const steps = (goal.match(/\b(and|then|after that|finally|next|also)\b/gi) ?? []).length;
    if (steps > 0) { score += Math.min(0.3, steps * 0.1); signals.push(`${steps} sequencing conjunctions`); }

    // Plan size dominates when available.
    const planStepCount = options.plan?.steps.length ?? 0;
    if (planStepCount > 3) { score += 0.2; signals.push(`plan has ${planStepCount} steps`); }
    if (planStepCount > 10) { score += 0.15; signals.push("large plan"); }

    // Parallelism hints.
    if (/\b(each|every|all)\b/i.test(goal)) { score += 0.1; signals.push("bulk/parallel hint"); }

    // Prior failures raise caution.
    const fails = options.previousFailures ?? 0;
    if (fails > 0) { score += Math.min(0.2, fails * 0.1); signals.push(`${fails} previous failure(s)`); }

    if (options.observationsCount && options.observationsCount > 10) {
      score += 0.1;
      signals.push("long-running (many observations)");
    }
    if (options.priority === "critical") { score += 0.05; signals.push("critical priority"); }

    const estimatedComplexity = Math.min(1, Math.round(score * 100) / 100);
    const complexity = estimatedComplexity < 0.35 ? "simple" : estimatedComplexity < 0.7 ? "moderate" : "complex";

    // 3) Reasoning level from complexity + type.
    const reasoningLevel: ReasoningLevel =
      type === "reasoning" || type === "coding" || complexity === "complex" || (type === "mixed" && /\b(analyze|decide|compare|evaluate)\b/i.test(goal))
        ? "deep"
        : complexity === "simple" && type !== "mixed"
          ? "minimal"
          : "moderate";

    // 4) Implied tool prefixes from type.
    const impliedToolPrefixes: Record<TaskType, readonly string[]> = {
      filesystem: ["file."],
      coding: ["file.", "command."],
      reasoning: [],
      summarization: [],
      vision: ["screen.", "python."],
      retrieval: ["file.", "command."],
      automation: ["app.", "window.", "keyboard.", "mouse.", "process."],
      mixed: [],
      unknown: [],
    };

    const approxInputChars = goal.length + (options.plan ? JSON.stringify(options.plan).length : 0) + (options.observationsCount ?? 0) * 220;

    return {
      goal,
      type,
      complexity,
      estimatedComplexity,
      reasoningLevel,
      approxInputChars,
      impliedToolPrefixes: impliedToolPrefixes[type] ?? [],
      signals,
    };
  }
}
