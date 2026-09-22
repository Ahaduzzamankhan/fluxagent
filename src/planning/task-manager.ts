/**
 * FluxAgent — task management + prioritization.
 *
 * Foundations for multiple concurrent tasks: priority, status machine,
 * dependencies, deadlines, blocking reasons. Deliberately NOT a scheduler —
 * pickNext() is the simple, deterministic policy the runtime uses today.
 */

import { ids } from "../utils/ids.ts";

export type TaskStatus =
  | "queued"
  | "active"
  | "waiting"
  | "blocked"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "critical";

const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

/** Allowed status transitions (state machine). */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["active", "cancelled"],
  active: ["waiting", "blocked", "paused", "completed", "failed", "cancelled"],
  waiting: ["active", "blocked", "cancelled"],
  blocked: ["waiting", "active", "cancelled"],
  paused: ["active", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: ["queued"],
};

export interface ManagedTask {
  readonly id: string;
  readonly goal: string;
  readonly priority: TaskPriority;
  status: TaskStatus;
  readonly dependsOn: readonly string[];
  /** ISO deadline; overdue tasks rank above their priority. */
  readonly deadline?: string;
  readonly blockingReason?: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly parentTaskId?: string;
  /** Links to the session that ran/is running this task. */
  readonly sessionId?: string;
}

export function createManagedTask(spec: {
  goal: string;
  priority?: TaskPriority;
  dependsOn?: readonly string[];
  deadline?: string;
  parentTaskId?: string;
}): ManagedTask {
  return {
    id: ids.run(),
    goal: spec.goal,
    priority: spec.priority ?? "normal",
    status: "queued",
    dependsOn: spec.dependsOn ?? [],
    ...(spec.deadline ? { deadline: spec.deadline } : {}),
    ...(spec.parentTaskId ? { parentTaskId: spec.parentTaskId } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export class TaskTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid task transition: ${from} -> ${to}`);
    this.name = "TaskTransitionError";
  }
}

/** Transition with validation; throws TaskTransitionError on illegal moves. */
export function transition(task: ManagedTask, to: TaskStatus, blockingReason?: string): ManagedTask {
  if (!TRANSITIONS[task.status].includes(to)) {
    throw new TaskTransitionError(task.status, to);
  }
  return {
    ...task,
    status: to,
    ...(to === "blocked" || to === "waiting" ? { blockingReason: blockingReason ?? task.blockingReason } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export function isOverdue(task: ManagedTask, now = new Date()): boolean {
  return task.deadline !== undefined && new Date(task.deadline) < now && !isTerminal(task.status);
}

export function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

// ─── TaskManager ──────────────────────────────────────────────────────────────

export interface TaskManagerOptions {
  /** Max tasks kept in the ledger (oldest terminal tasks trimmed first). */
  readonly maxTasks?: number;
}

export class TaskManager {
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly maxTasks: number;

  constructor(options: TaskManagerOptions = {}) {
    this.maxTasks = options.maxTasks ?? 200;
  }

  add(spec: Parameters<typeof createManagedTask>[0]): ManagedTask {
    const task = createManagedTask(spec);
    this.tasks.set(task.id, task);
    this.trim();
    return task;
  }

  get(id: string): ManagedTask | undefined {
    return this.tasks.get(id);
  }

  /** Apply a status transition; throws on illegal transitions. */
  update(id: string, to: TaskStatus, blockingReason?: string): ManagedTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    const next = transition(task, to, blockingReason);
    this.tasks.set(id, next);
    return next;
  }

  /** All tasks in creation order. */
  list(): readonly ManagedTask[] {
    return [...this.tasks.values()];
  }

  /**
   * Deterministic pick-next policy:
   *   queued tasks whose dependencies are all completed, sorted by
   *   (overdue first, priority rank, then FIFO).
   */
  pickNext(now = new Date()): ManagedTask | undefined {
    const candidates = this.tasks
      .get ? [...this.tasks.values()] : [];
    void candidates;
    const eligible = [...this.tasks.values()].filter((t) => {
      if (t.status !== "queued") return false;
      return t.dependsOn.every((dep) => {
        const d = this.tasks.get(dep);
        return d !== undefined && d.status === "completed";
      });
    });
    if (eligible.length === 0) return undefined;
    return eligible.sort((a, b) => {
      const overdueA = isOverdue(a, now) ? 1 : 0;
      const overdueB = isOverdue(b, now) ? 1 : 0;
      if (overdueA !== overdueB) return overdueB - overdueA;
      const pr = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      if (pr !== 0) return pr;
      return a.createdAt.localeCompare(b.createdAt);
    })[0];
  }

  /** Tasks blocked because their dependencies are failed/cancelled. */
  blockedTasks(): readonly { task: ManagedTask; reason: string }[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === "queued" || t.status === "blocked")
      .map((t) => {
        for (const dep of t.dependsOn) {
          const d = this.tasks.get(dep);
          if (d && (d.status === "failed" || d.status === "cancelled")) {
            return { task: t, reason: `dependency ${d.id} (${d.status})` };
          }
        }
        return null;
      })
      .filter((x): x is { task: ManagedTask; reason: string } => x !== null);
  }

  private trim(): void {
    if (this.tasks.size <= this.maxTasks) return;
    const terminal = [...this.tasks.values()]
      .filter((t) => isTerminal(t.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const excess = this.tasks.size - this.maxTasks;
    for (let i = 0; i < Math.min(excess, terminal.length); i++) {
      this.tasks.delete(terminal[i]!.id);
    }
  }
}
