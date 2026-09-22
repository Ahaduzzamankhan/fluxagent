/**
 * FluxAgent — advanced decision engine (Phase 6.1).
 *
 * Extends the Phase 3 heuristic engine with full decision context:
 *
 *   Task → Analyze (task-analysis) → Estimate complexity → Select strategy
 *        → Select model (model router) → Select tools (discovery) → confidence
 *
 * The advanced engine WRAPS the base heuristic: all base behaviors (budgets,
 * failure reactions, permission waits) are preserved; the wrapper enriches
 * decisions with task analysis, a selected execution strategy, a routed model,
 * tool recommendations from discovery, and a ConfidenceEstimate (metadata —
 * never truth). An LLM-backed engine can implement the same interface later.
 */

import { HeuristicDecisionEngine, type Decision, type DecisionInput, type DecisionEngine } from "./decision.ts";
import { diagnose } from "./diagnosis.ts";
import { HeuristicTaskAnalyzer, type TaskAnalysis, type TaskType } from "./task-analysis.ts";
import { combineConfidence, confidence, fromSuccessRate, type ConfidenceEstimate } from "./confidence.ts";
import type { ToolDiscovery } from "../tools/discovery.ts";
import type { ModelRouterService } from "../llm/router.ts";
import type { ModelDescriptor } from "../llm/model.ts";
import type { ToolRegistry } from "../tools/registry.ts";

// ─── Strategy selection ───────────────────────────────────────────────────────

export type ExecutionStrategyName =
  | "direct" // proceed step-by-step with the planned tools
  | "cautious" // verify every mutating step, low concurrency
  | "fast-path" // skip optional verifications, prefer cheap models
  | "delegated" // hand off scoped subtasks to subagents
  | "salvage"; // prior failure: minimize work, prefer alternatives

export interface ExecutionStrategy {
  readonly name: ExecutionStrategyName;
  readonly description: string;
  /** Fraction of steps that get explicit verification (0..1). */
  readonly verifyFraction: number;
  /** Max steps of budget the strategy is willing to spend. */
  readonly budgetMultiplier: number;
  /** Model complexity preference for routing. */
  readonly modelComplexity: "simple" | "moderate" | "complex";
}

export const STRATEGIES: Readonly<Record<ExecutionStrategyName, ExecutionStrategy>> = {
  direct: { name: "direct", description: "standard step-by-step execution", verifyFraction: 0.3, budgetMultiplier: 1, modelComplexity: "moderate" },
  cautious: { name: "cautious", description: "verify every mutating step; conservative budgets", verifyFraction: 1, budgetMultiplier: 1.25, modelComplexity: "complex" },
  "fast-path": { name: "fast-path", description: "skip optional verification for simple tasks", verifyFraction: 0, budgetMultiplier: 0.8, modelComplexity: "simple" },
  delegated: { name: "delegated", description: "delegate parallelizable work to subagents", verifyFraction: 0.4, budgetMultiplier: 1, modelComplexity: "moderate" },
  salvage: { name: "salvage", description: "recovery mode: prefer alternative tools, minimize spend", verifyFraction: 0.6, budgetMultiplier: 0.6, modelComplexity: "moderate" },
};

export interface StrategyContext {
  readonly analysis: TaskAnalysis;
  readonly recentFailureCategories: readonly string[];
  readonly replansUsed: number;
  readonly stepsExecuted: number;
  readonly maxSteps: number;
}

export function selectStrategy(ctx: StrategyContext): ExecutionStrategy {
  const { analysis } = ctx;
  // Salvage first: prior failures dominate.
  const structural = ctx.recentFailureCategories.some((c) => c === "tool" || c === "dependency" || c === "state");
  if (structural || ctx.replansUsed > 0) return STRATEGIES.salvage;
  // Cautious: high risk surfaces (mutating domains, complex) or critical priority.
  if (analysis.complexity === "complex" || analysis.type === "filesystem" || analysis.type === "automation") {
    return STRATEGIES.cautious;
  }
  // Delegated: parallelizable bulk work.
  if (analysis.signals.some((s) => /bulk\/parallel/.test(s))) return STRATEGIES.delegated;
  // Fast path: trivial tasks.
  if (analysis.complexity === "simple" && analysis.type !== "coding") return STRATEGIES["fast-path"];
  return STRATEGIES.direct;
}

// ─── Decision context ─────────────────────────────────────────────────────────

export interface AdvancedDecision extends Decision {
  readonly taskAnalysis: TaskAnalysis;
  readonly strategy: ExecutionStrategy;
  readonly routedModel?: ModelDescriptor;
  readonly recommendedTools: readonly string[];
  /** Structured confidence — metadata with basis; replaces bare `confidence`. */
  readonly confidenceEstimate: ConfidenceEstimate;
}

export interface AdvancedDecisionEngineOptions {
  readonly registry: ToolRegistry;
  readonly discovery?: ToolDiscovery;
  readonly modelRouter?: ModelRouterService;
  /** Historical outcomes keyed by tool name (from ExecutionLedger). */
  readonly toolHistory?: ReadonlyMap<string, { successes: number; failures: number }>;
}

export interface AdvancedDecisionInput extends DecisionInput {
  /** Task priority for analysis/strategy. */
  readonly priority?: "low" | "normal" | "high" | "critical";
}

export class AdvancedDecisionEngine implements DecisionEngine {
  private readonly base: HeuristicDecisionEngine;
  private readonly analyzer: HeuristicTaskAnalyzer;
  private readonly discovery?: ToolDiscovery;
  private readonly modelRouter?: ModelRouterService;
  private readonly toolHistory?: ReadonlyMap<string, { successes: number; failures: number }>;

  constructor(options: AdvancedDecisionEngineOptions) {
    this.base = new HeuristicDecisionEngine(options.registry);
    this.analyzer = new HeuristicTaskAnalyzer();
    this.discovery = options.discovery;
    this.modelRouter = options.modelRouter;
    this.toolHistory = options.toolHistory;
  }

  decide(input: DecisionInput): Decision {
    return this.decideAdvanced(input as AdvancedDecisionInput);
  }

  decideAdvanced(input: AdvancedDecisionInput): AdvancedDecision {
    const baseDecision = this.base.decide(input);

    // 1) Analyze the task (cached implicitly by cheapness — pure heuristics).
    const recentFailureCategories = input.observations
      .filter((o) => !o.ok)
      .slice(-3)
      .map((o) => diagnose(o).category);
    const analysis = this.analyzer.analyze(input.goal, {
      plan: input.plan,
      observationsCount: input.observations.length,
      priority: input.priority,
      previousFailures: recentFailureCategories.length,
    });

    // 2) Select strategy.
    const strategy = selectStrategy({
      analysis,
      recentFailureCategories,
      replansUsed: input.replansUsed,
      stepsExecuted: input.stepsExecuted,
      maxSteps: input.maxSteps,
    });

    // 3) Route a model (when a router is available).
    const routedModel = this.modelRouter?.selectOrDefault({
      purpose: analysis.type === "vision" ? "vision" : strategy.modelComplexity === "simple" ? "summarize" : "plan",
      complexity: strategy.modelComplexity,
      approxInputChars: analysis.approxInputChars,
    });

    // 4) Recommend tools by discovery (when available).
    const recommendedTools = this.recommendTools(analysis);

    // 5) Confidence: combine heuristic + historical bases.
    const parts: ConfidenceEstimate[] = [
      confidence(baseDecision.confidence, "heuristic", `decision:${baseDecision.action}`),
    ];
    const targetTool = baseDecision.target;
    if (targetTool && this.toolHistory?.has(targetTool)) {
      const h = this.toolHistory.get(targetTool)!;
      parts.push(fromSuccessRate(h.successes, h.successes + h.failures, `tool:${targetTool}`));
    }
    if (routedModel) {
      parts.push(confidence(Math.min(1, routedModel.quality / 10), "heuristic", `model:${routedModel.id}`));
    }
    const confidenceEstimate = combineConfidence(parts);

    return {
      ...baseDecision,
      taskAnalysis: analysis,
      strategy,
      ...(routedModel ? { routedModel } : {}),
      recommendedTools,
      confidenceEstimate,
    };
  }

  private recommendTools(analysis: TaskAnalysis): readonly string[] {
    if (!this.discovery || analysis.impliedToolPrefixes.length === 0) return [];
    const names: string[] = [];
    for (const prefix of analysis.impliedToolPrefixes) {
      for (const t of this.discovery.discover({ maxPermission: "SAFE_WRITE" })) {
        if (t.info.name.startsWith(prefix) && !names.includes(t.info.name)) names.push(t.info.name);
      }
    }
    return names.slice(0, 8);
  }
}

// Re-export TaskType for consumers of analysis results.
export type { TaskType };
