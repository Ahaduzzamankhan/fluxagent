/**
 * FluxAgent — planner.
 *
 * Converts an LLM PlannedPlan into a typed Plan with validated steps and
 * dependency order. Also supports manual construction (deterministic plans in
 * tests) and replanning (plan revision bump + merge).
 */

import { createPlan, createStep, topoSort, type Plan, type PlanStep } from "../planning/plan.ts";
import type { PlannedPlan, PlannedStep } from "../llm/provider.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { FluxError } from "../utils/errors.ts";

export interface PlannerOptions {
  readonly registry: ToolRegistry;
  readonly maxPlanSteps?: number;
  readonly logger?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export class Planner {
  private readonly registry: ToolRegistry;
  private readonly maxPlanSteps: number;
  private readonly logger?: PlannerOptions["logger"];

  constructor(options: PlannerOptions) {
    this.registry = options.registry;
    this.maxPlanSteps = options.maxPlanSteps ?? 25;
    this.logger = options.logger;
  }

  /** Build a Plan from the LLM's proposed steps (validates tool names). */
  buildPlan(goal: string, proposed: PlannedPlan): Plan {
    if (!proposed.steps?.length) {
      throw new FluxError({ code: "E_PLAN_INVALID", message: "LLM produced a plan with no steps" });
    }
    if (proposed.steps.length > this.maxPlanSteps) {
      throw new FluxError({
        code: "E_PLAN_INVALID",
        message: `plan too large (${proposed.steps.length} steps > max ${this.maxPlanSteps})`,
      });
    }

    const steps: PlanStep[] = proposed.steps.map((ps: PlannedStep) =>
      createStep({
        title: ps.title?.slice(0, 200) ?? "unnamed step",
        description: ps.description ?? ps.title ?? "",
        tool: this.resolveTool(ps),
        args: ps.args ?? {},
        ...(ps.dependsOn ? { dependsOn: ps.dependsOn } : {}),
      }),
    );

    // Remap LLM step ids onto generated ids; rebuild dependsOn.
    const idMap = new Map<string, string>();
    proposed.steps.forEach((ps: PlannedStep, i: number) => {
      if (ps.id) idMap.set(ps.id, steps[i]!.id);
    });
    for (const step of steps) {
      const remapped = step.dependsOn
        .map((dep) => idMap.get(dep) ?? dep)
        .filter((dep) => steps.some((s) => s.id === dep));
      (step as { dependsOn: string[] }).dependsOn = remapped;
    }

    let ordered: PlanStep[];
    try {
      ordered = topoSort(steps);
    } catch (err) {
      throw new FluxError({
        code: "E_PLAN_INVALID",
        message: err instanceof Error ? err.message : "invalid plan dependencies",
      });
    }

    return createPlan(goal, proposed.summary ?? "", ordered);
  }

  /** Deterministic plan construction for tests/tools without an LLM. */
  buildManualPlan(goal: string, steps: Parameters<Planner["buildStep"]>[]): Plan {
    return this.buildPlan(goal, {
      summary: `manual plan: ${goal}`,
      steps: steps.map((s) => ({ title: s.title, description: s.description, tool: s.tool, args: s.args, dependsOn: s.dependsOn })),
    });
  }

  buildStep(spec: { title: string; description?: string; tool?: string | null; args?: Record<string, unknown>; dependsOn?: string[] }): PlannedStep {
    return { title: spec.title, description: spec.description, tool: spec.tool ?? undefined, args: spec.args, dependsOn: spec.dependsOn };
  }

  /** Replan: keep completed steps, append new ones as a new revision. */
  revise(plan: Plan, additions: PlannedStep[], reason: string): Plan {
    const kept = plan.steps.filter((s) => s.status === "completed" || s.status === "skipped");
    const newSteps = additions.map((ps) =>
      createStep({
        title: ps.title,
        description: ps.description ?? ps.title,
        tool: this.resolveTool(ps),
        args: ps.args ?? {},
      }),
    );
    return {
      ...plan,
      revision: plan.revision + 1,
      summary: `${plan.summary} | replan(${reason})`,
      steps: [...kept, ...newSteps],
    };
  }

  private resolveTool(ps: PlannedStep): string | null {
    if (!ps.tool || ps.tool === "null") return null;
    if (!this.registry.has(ps.tool)) {
      // Keep the name: the executor will fail the step with E_TOOL_NOT_FOUND
      // and recovery can replan. Silently converting tool steps to reasoning
      // steps would hide planning errors.
      this.logger?.warn("plan references unknown tool; step will fail at execution", {
        tool: ps.tool,
        title: ps.title,
      });
    }
    return ps.tool;
  }
}
