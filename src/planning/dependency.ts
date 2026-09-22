/**
 * FluxAgent — dependency analysis for plans.
 *
 * Currently thin helpers over plan.ts (kept as its own module so richer
 * dependency semantics — conditions, retries, dynamic dependencies — can be
 * added without touching plan.ts).
 */

import { dependenciesSatisfied, anyDependencyFailed, type PlanStep } from "./plan.ts";

export { dependenciesSatisfied, anyDependencyFailed };

export interface DependencyReport {
  readonly readyStepIds: readonly string[];
  readonly blockedStepIds: readonly string[];
  readonly failedDependencyStepIds: readonly string[];
}

export function analyzeDependencies(steps: readonly PlanStep[]): DependencyReport {
  const ready: string[] = [];
  const blocked: string[] = [];
  const failedDep: string[] = [];
  for (const s of steps) {
    if (s.status !== "pending") continue;
    if (anyDependencyFailed(s, steps)) failedDep.push(s.id);
    else if (dependenciesSatisfied(s, steps)) ready.push(s.id);
    else blocked.push(s.id);
  }
  return { readyStepIds: ready, blockedStepIds: blocked, failedDependencyStepIds: failedDep };
}

/** Build dependency edges from a plan; used by tests/inspector tooling. */
export function dependencyEdges(steps: readonly PlanStep[]): { from: string; to: string }[] {
  const edges: { from: string; to: string }[] = [];
  for (const s of steps) {
    for (const dep of s.dependsOn) {
      edges.push({ from: dep, to: s.id });
    }
  }
  return edges;
}
