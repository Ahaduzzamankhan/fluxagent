/**
 * FluxAgent — task helpers.
 */

import { createTask, type PlanStep, type Task } from "./plan.ts";

export { createTask, type Task };

/** Transition a task status with validation of allowed transitions. */
export function transitionTask(task: Task, status: Task["status"]): Task {
  const allowed: Record<Task["status"], readonly Task["status"][]> = {
    active: ["completed", "failed", "cancelled"],
    completed: [],
    failed: ["active"],
    cancelled: ["active"],
  };
  if (!allowed[task.status].includes(status)) {
    throw new Error(`Invalid task transition ${task.status} -> ${status}`);
  }
  return { ...task, status };
}

/** Derive a Task from a goal string — used when the runtime boots a session. */
export function taskFromGoal(goal: string): Task {
  return createTask(goal);
}

/** Is the plan for this task complete (all steps terminal, ≥1 step)? */
export function isPlanComplete(steps: readonly PlanStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.status === "completed" || s.status === "skipped");
}

export function countByStatus(steps: readonly PlanStep[]): Record<StepStatusLite, number> {
  const counts: Record<StepStatusLite, number> = {
    pending: 0, running: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, skipped: 0,
  };
  for (const s of steps) counts[s.status] += 1;
  return counts;
}

export type StepStatusLite = PlanStep["status"];
