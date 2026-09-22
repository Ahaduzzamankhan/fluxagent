/**
 * FluxAgent — planning primitives: Step, Task, Plan, dependencies.
 */

import { ids } from "../utils/ids.ts";
import type { FluxErrorJSON } from "../utils/errors.ts";

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "skipped";

export interface StepResultData {
  readonly summary: string;
  readonly observationId?: string;
  readonly output?: unknown;
}

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Registered tool name, or null for pure-reasoning/verification steps. */
  readonly tool: string | null;
  readonly args: Readonly<Record<string, unknown>>;
  readonly dependsOn: readonly string[];
  status: StepStatus;
  result?: StepResultData;
  error?: FluxErrorJSON;
  retryCount: number;
  /** Verification guidance for the observer. */
  readonly verify?: string;
}

export interface Task {
  readonly id: string;
  readonly goal: string;
  readonly createdAt: string;
  status: "active" | "completed" | "failed" | "cancelled";
  planIds: readonly string[];
}

export function createTask(goal: string): Task {
  return {
    id: ids.run(),
    goal,
    createdAt: new Date().toISOString(),
    status: "active",
    planIds: [],
  };
}

export interface Plan {
  readonly id: string;
  readonly goal: string;
  readonly createdAt: string;
  revision: number;
  summary: string;
  steps: PlanStep[];
}

export function createPlan(goal: string, summary: string, steps: PlanStep[]): Plan {
  return { id: ids.plan(), goal, createdAt: new Date().toISOString(), revision: 1, summary, steps };
}

export function createStep(input: {
  title: string;
  description: string;
  tool: string | null;
  args?: Record<string, unknown>;
  dependsOn?: readonly string[];
  verify?: string;
}): PlanStep {
  return {
    id: ids.step(),
    title: input.title,
    description: input.description,
    tool: input.tool,
    args: input.args ?? {},
    dependsOn: input.dependsOn ?? [],
    status: "pending",
    retryCount: 0,
    ...(input.verify ? { verify: input.verify } : {}),
  };
}

// ─── Dependency helpers ───────────────────────────────────────────────────────

/**
 * Are all dependencies of `step` satisfied? A dependency is satisfied when
 * the referenced step is completed or skipped.
 */
export function dependenciesSatisfied(step: PlanStep, steps: readonly PlanStep[]): boolean {
  return step.dependsOn.every((depId) => {
    const dep = steps.find((s) => s.id === depId);
    if (!dep) return true; // dangling dependency: treat as satisfied (logged by planner)
    return dep.status === "completed" || dep.status === "skipped";
  });
}

export function anyDependencyFailed(step: PlanStep, steps: readonly PlanStep[]): PlanStep | undefined {
  return step.dependsOn
    .map((depId) => steps.find((s) => s.id === depId))
    .find((dep) => dep && (dep.status === "failed" || dep.status === "cancelled"));
}

/** Topologically sort steps by dependsOn; detects cycles. */
export function topoSort(steps: readonly PlanStep[]): PlanStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: PlanStep[] = [];

  const visit = (step: PlanStep): void => {
    if (visited.has(step.id)) return;
    if (visiting.has(step.id)) {
      throw new Error(`Plan contains a dependency cycle involving step "${step.title}"`);
    }
    visiting.add(step.id);
    for (const depId of step.dependsOn) {
      const dep = byId.get(depId);
      if (dep) visit(dep);
    }
    visiting.delete(step.id);
    visited.add(step.id);
    out.push(step);
  };

  for (const s of steps) visit(s);
  return out;
}
