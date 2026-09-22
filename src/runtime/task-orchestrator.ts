/**
 * FluxAgent — task orchestrator (Phase 7).
 *
 * Builds on TaskManager (planning/task-manager.ts) — it owns the ledger and
 * status machine; the orchestrator adds EXECUTION:
 *
 *   - dependency graphs with cycle detection
 *   - parallel execution of independent ready tasks
 *   - concurrency limits + per-task timeouts + failure isolation
 *   - priority queue (critical → background) with deadline boost
 *   - long-running tasks: checkpoint → pause → resume → verify → complete
 *
 * Task runners are injected (task id → async fn), keeping the orchestrator
 * decoupled from the agent itself. Reliability (retry/backoff/breaker) is
 * composed per task via the Phase 7.5 primitives.
 */

import type { Logger } from "../utils/logger.ts";
import type { EventBus } from "../events/event-bus.ts";
import {
  TaskManager,
  isTerminal,
  isOverdue,
  type ManagedTask,
  type TaskPriority,
} from "../planning/task-manager.ts";

// ─── Priority queue ───────────────────────────────────────────────────────────

export type QueuePriority = "background" | "low" | "normal" | "high" | "critical";

const QUEUE_RANK: Readonly<Record<QueuePriority, number>> = {
  background: 0,
  low: 1,
  normal: 2,
  high: 3,
  critical: 4,
};

export function priorityRank(p: QueuePriority | TaskPriority): number {
  return QUEUE_RANK[p as QueuePriority] ?? QUEUE_RANK.normal;
}

/** Dequeue order: overdue → priority rank → FIFO insertion. */
export class PriorityQueue<T> {
  private items: { value: T; rank: number; at: number }[] = [];
  private seq = 0;

  push(value: T, rank: QueuePriority | TaskPriority, overdue = false): void {
    this.items.push({
      value,
      rank: priorityRank(rank) + (overdue ? 10 : 0),
      at: ++this.seq,
    });
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    this.items.sort((a, b) => (b.rank - a.rank) || (a.at - b.at));
    return this.items.shift()!.value;
  }

  get size(): number {
    return this.items.length;
  }

  drain(): readonly T[] {
    const out: T[] = [];
    let v = this.pop();
    while (v !== undefined) {
      out.push(v);
      v = this.pop();
    }
    return out;
  }
}

// ─── Dependency graph ─────────────────────────────────────────────────────────

export interface GraphReport {
  readonly order: readonly string[]; // topological order (valid when acyclic)
  readonly cycles: readonly string[][]; // each cycle = list of task ids
}

/** Kahn's algorithm + cycle detection over the task dependency graph. */
export function analyzeTaskGraph(tasks: readonly Pick<ManagedTask, "id" | "dependsOn">[]): GraphReport {
  const ids = new Set(tasks.map((t) => t.id));
  const edges = new Map<string, string[]>(); // dep → dependents
  const indegree = new Map<string, number>();
  for (const t of tasks) {
    if (!indegree.has(t.id)) indegree.set(t.id, 0);
    for (const dep of t.dependsOn) {
      if (!ids.has(dep)) continue; // unknown deps ignored (ledger trimmed)
      edges.set(dep, [...(edges.get(dep) ?? []), t.id]);
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
    }
  }

  const queue = [...tasks.map((t) => t.id)].filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of edges.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  // Anything not in `order` is part of (or downstream of) a cycle.
  const ordered = new Set(order);
  const remaining = tasks.map((t) => t.id).filter((id) => !ordered.has(id));
  const cycles: string[][] = remaining.length > 0 ? [remaining] : [];
  return { order, cycles };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export type TaskRunner = (task: ManagedTask, ctx: { signal: AbortSignal; checkpoint: () => Promise<void> }) => Promise<unknown>;

export interface OrchestrationOptions {
  readonly concurrency?: number;
  /** Per-task timeout in ms; undefined disables. */
  readonly taskTimeoutMs?: number;
  /** Default retry policy per task. */
  readonly maxAttemptsPerTask?: number;
  readonly baseDelayMs?: number;
  readonly logger?: Logger;
  readonly eventBus?: EventBus;
  /** Called after each task completes — used for checkpoints/learning. */
  readonly onTaskDone?: (task: ManagedTask, ok: boolean) => Promise<void> | void;
  /** Long-running task checkpoint hook (persist via CheckpointManager). */
  readonly onCheckpoint?: (task: ManagedTask) => Promise<void> | void;
}

export interface OrchestratorStatus {
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

interface RunningEntry {
  readonly taskId: string;
  readonly controller: AbortController;
  readonly startedAt: number;
}

export class TaskOrchestrator {
  private readonly tasks: TaskManager;
  private readonly runners = new Map<string, TaskRunner>();
  private readonly queue = new PriorityQueue<string>();
  private readonly running = new Map<string, RunningEntry>();
  private readonly opts: Required<Pick<OrchestrationOptions, "concurrency" | "maxAttemptsPerTask" | "baseDelayMs">> & OrchestrationOptions;
  private paused = false;
  private tickScheduled = false;
  private cancelAllController: AbortController | null = null;

  constructor(tasks: TaskManager, options: OrchestrationOptions = {}) {
    this.tasks = tasks;
    this.opts = {
      concurrency: options.concurrency ?? 4,
      taskTimeoutMs: options.taskTimeoutMs,
      maxAttemptsPerTask: options.maxAttemptsPerTask ?? 2,
      baseDelayMs: options.baseDelayMs ?? 250,
      logger: options.logger,
      eventBus: options.eventBus,
      onTaskDone: options.onTaskDone,
      onCheckpoint: options.onCheckpoint,
    };
  }

  /** Register a runner for a task; queued immediately if idempotent-ready. */
  submit(task: ManagedTask, runner: TaskRunner): ManagedTask {
    if (this.runners.has(task.id)) {
      throw new Error(`task already submitted: ${task.id}`);
    }
    this.runners.set(task.id, runner);
    this.queue.push(task.id, task.priority, isOverdue(task));
    void this.tryStart();
    return task;
  }

  /** Stop dequeuing new work; running tasks continue. */
  pause(): void {
    this.paused = true;
  }

  /** Resume dequeuing. */
  resume(): void {
    this.paused = false;
    void this.tryStart();
  }

  /** Cancel one running task. */
  cancel(taskId: string, reason = "cancelled by caller"): boolean {
    const entry = this.running.get(taskId);
    if (!entry) return false;
    entry.controller.abort(reason);
    return true;
  }

  /** Cancel everything and stop accepting work (session teardown). */
  cancelAll(reason = "orchestrator cancelled"): void {
    this.paused = true;
    this.cancelAllController?.abort(reason);
    for (const entry of this.running.values()) {
      entry.controller.abort(reason);
    }
  }

  get runningCount(): number {
    return this.running.size;
  }

  status(): OrchestratorStatus {
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    for (const t of this.tasks.list()) {
      if (t.status === "completed") completed++;
      else if (t.status === "failed") failed++;
      else if (t.status === "cancelled") cancelled++;
    }
    return {
      queued: this.queue.size,
      running: this.running.size,
      completed,
      failed,
      cancelled,
    };
  }

  /** Wait until no tasks are queued or running. */
  async waitForIdle(): Promise<void> {
    while (this.queue.size > 0 || this.running.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private scheduleTick(): void {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    setTimeout(() => {
      this.tickScheduled = false;
      void this.tryStart();
    }, 0).unref?.();
  }

  private tryStart(): void {
    if (this.paused) return;
    // Cycle detection: a cycle means nothing more will ever run.
    const graph = analyzeTaskGraph(this.tasks.list().filter((t) => !isTerminal(t.status)));
    for (const cycle of graph.cycles) {
      this.opts.logger?.error("dependency cycle detected; failing cycle members", { cycle });
      for (const id of cycle) {
        const t = this.tasks.get(id);
        if (t && (t.status === "queued" || t.status === "blocked")) {
          this.tasks.update(id, "cancelled", "dependency cycle");
          this.runners.delete(id);
        }
      }
    }

    while (this.running.size < this.opts.concurrency) {
      const id = this.dequeueReady();
      if (!id) break;
      this.startTask(id);
    }
  }

  private dequeueReady(): string | undefined {
    // Drain the queue in priority order, skipping blocked tasks (they stay).
    const size = this.queue.size;
    const kept: string[] = [];
    let chosen: string | undefined;
    for (let i = 0; i < size; i++) {
      const id = this.queue.pop();
      if (id === undefined) break;
      const task = this.tasks.get(id);
      if (!task || isTerminal(task.status) || task.status === "active") continue; // stale
      const ready = task.dependsOn.every((d) => this.tasks.get(d)?.status === "completed");
      if (ready) {
        chosen = id;
        break;
      }
      kept.push(id);
    }
    for (const id of kept) {
      const t = this.tasks.get(id);
      if (t && !isTerminal(t.status)) this.queue.push(id, t.priority, isOverdue(t));
    }
    if (chosen) return chosen;
    if (kept.length > 0) {
      // All queued tasks are dependency-blocked; mark blocked for observability.
      for (const id of kept) {
        const t = this.tasks.get(id);
        if (t && t.status === "queued" && t.dependsOn.some((d) => {
          const dep = this.tasks.get(d);
          return dep && (dep.status === "failed" || dep.status === "cancelled");
        })) {
          try {
            this.tasks.update(id, "blocked", "dependency failed or cancelled");
          } catch { /* transition race — fine */ }
        }
      }
      this.scheduleTick(); // wake when a dependency may finish
    }
    return undefined;
  }

  private startTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    const runner = this.runners.get(taskId);
    if (!task || !runner) return;

    const controller = new AbortController();
    const entry: RunningEntry = { taskId, controller, startedAt: Date.now() };
    this.running.set(taskId, entry);
    this.tasks.update(taskId, "active");

    void this.runTask(task, runner, controller, entry).finally(() => {
      this.running.delete(taskId);
      this.runners.delete(taskId);
      this.scheduleTick();
    });
  }

  private async runTask(
    task: ManagedTask,
    runner: TaskRunner,
    controller: AbortController,
    entry: RunningEntry,
  ): Promise<void> {
    let lastError: unknown;
    let timedOut = false;
    for (let attempt = 1; attempt <= this.opts.maxAttemptsPerTask; attempt++) {
      try {
        const checkpoint = async (): Promise<void> => {
          if (this.opts.onCheckpoint) await this.opts.onCheckpoint(task);
        };
        const work = runner(task, { signal: controller.signal, checkpoint });
        const value = this.opts.taskTimeoutMs !== undefined
          ? await this.timeoutRace(work, controller, this.opts.taskTimeoutMs, task.id)
          : await work;
        // Distinguish external cancel (user) from self-inflicted timeout abort:
        // timeouts abort with a reason string containing "timed out" and are
        // handled as failures in the catch path; external cancels settle here.
        if (controller.signal.aborted && !timedOut) {
          this.tasks.update(task.id, "cancelled");
          return;
        }
        void value;
        this.tasks.update(task.id, "completed");
        await this.opts.onTaskDone?.(task, true);
        return;
      } catch (err) {
        lastError = err;
        const abortReason = controller.signal.reason;
        const isTimeout = typeof abortReason === "string" && abortReason.includes("timed out");
        if (controller.signal.aborted && !isTimeout) {
          this.tasks.update(task.id, "cancelled");
          return;
        }
        if (isTimeout) timedOut = true;
        this.opts.logger?.warn("task attempt failed", { taskId: task.id, attempt, error: err instanceof Error ? err.message : String(err) });
        if (attempt < this.opts.maxAttemptsPerTask && !timedOut) {
          const delay = Math.min(8_000, this.opts.baseDelayMs * 2 ** (attempt - 1));
          await new Promise((r) => setTimeout(r, delay));
          if (controller.signal.aborted && !isTimeout) {
            this.tasks.update(task.id, "cancelled");
            return;
          }
        }
      }
    }
    // Isolation: failure is contained to this task.
    this.tasks.update(task.id, "failed");
    await this.opts.onTaskDone?.(task, false);
    this.opts.logger?.error("task failed permanently", {
      taskId: task.id,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  private async timeoutRace(work: Promise<unknown>, controller: AbortController, timeoutMs: number, taskId: string): Promise<unknown> {
    let timer: NodeJS.Timeout | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(`task ${taskId} timed out after ${timeoutMs}ms`);
        reject(new Error(`task ${taskId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      void entry;
    }
  }
}
