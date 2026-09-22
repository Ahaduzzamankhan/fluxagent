/**
 * FluxAgent — checkpoints.
 *
 * Captures enough state to pause/resume/recover a task: plan, step states,
 * observations, retry budgets, memory refs, timestamps, and a schema version.
 * Storage is an abstraction (`CheckpointStore`); a JSON-file implementation is
 * provided, databases can be added later without touching the runtime.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { AgentState } from "../agent/state.ts";
import { ids } from "../utils/ids.ts";
import { makeEvent } from "../events/events.ts";
import type { EventBus } from "../events/event-bus.ts";

export const CHECKPOINT_VERSION = 1;

export interface Checkpoint {
  readonly id: string;
  readonly sessionId: string;
  readonly label: string;
  readonly version: number;
  readonly createdAt: string;
  readonly state: AgentState;
  /** Retry budget snapshot per step (stepId → retries used). */
  readonly retryBudgets: Readonly<Record<string, number>>;
}

export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(checkpointId: string): Promise<Checkpoint | undefined>;
  list(sessionId: string): Promise<readonly { id: string; label: string; createdAt: string }[]>;
  delete(checkpointId: string): Promise<void>;
  latest(sessionId: string): Promise<Checkpoint | undefined>;
}

// ─── In-memory store (default, tests, ephemeral runs) ────────────────────────

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly store = new Map<string, Checkpoint>();

  async save(checkpoint: Checkpoint): Promise<void> {
    this.store.set(checkpoint.id, checkpoint);
  }
  async load(checkpointId: string): Promise<Checkpoint | undefined> {
    return this.store.get(checkpointId);
  }
  async list(sessionId: string): Promise<readonly { id: string; label: string; createdAt: string }[]> {
    return [...this.store.values()]
      .filter((c) => c.sessionId === sessionId)
      .map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }
  async delete(checkpointId: string): Promise<void> {
    this.store.delete(checkpointId);
  }
  async latest(sessionId: string): Promise<Checkpoint | undefined> {
    const all = [...this.store.values()].filter((c) => c.sessionId === sessionId);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
}

// ─── JSON-file store (each checkpoint = one file) ─────────────────────────────

export class JsonFileCheckpointStore implements CheckpointStore {
  private readonly dir: string;

  constructor(directory: string) {
    this.dir = directory;
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.fileFor(checkpoint.id), JSON.stringify(checkpoint, null, 2), "utf8");
  }

  async load(checkpointId: string): Promise<Checkpoint | undefined> {
    try {
      const raw = await fs.readFile(this.fileFor(checkpointId), "utf8");
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return undefined;
    }
  }

  async list(sessionId: string): Promise<readonly { id: string; label: string; createdAt: string }[]> {
    try {
      const files = await fs.readdir(this.dir);
      const out: { id: string; label: string; createdAt: string }[] = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const cp = await this.load(f.replace(/\.json$/, ""));
        if (cp && cp.sessionId === sessionId) {
          out.push({ id: cp.id, label: cp.label, createdAt: cp.createdAt });
        }
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  async delete(checkpointId: string): Promise<void> {
    await fs.rm(this.fileFor(checkpointId), { force: true });
  }

  async latest(sessionId: string): Promise<Checkpoint | undefined> {
    const listed = await this.list(sessionId);
    const top = listed[0];
    return top ? this.load(top.id) : undefined;
  }
}

// ─── Checkpoint manager ───────────────────────────────────────────────────────

export interface CheckpointManagerDeps {
  readonly store: CheckpointStore;
  readonly eventBus?: EventBus;
}

export class CheckpointManager {
  private readonly store: CheckpointStore;
  private readonly eventBus?: EventBus;

  constructor(deps: CheckpointManagerDeps) {
    this.store = deps.store;
    this.eventBus = deps.eventBus;
  }

  /** Capture a checkpoint of the current run. */
  async create(input: {
    sessionId: string;
    label: string;
    state: AgentState;
    retryBudgets?: Record<string, number>;
  }): Promise<Checkpoint> {
    const cp: Checkpoint = {
      id: ids.run(),
      sessionId: input.sessionId,
      label: input.label,
      version: CHECKPOINT_VERSION,
      createdAt: new Date().toISOString(),
      state: structuredClone(input.state),
      retryBudgets: input.retryBudgets ?? {},
    };
    await this.store.save(cp);
    this.eventBus?.emitSync(
      makeEvent(input.sessionId, "checkpoint.saved", { label: cp.label }),
    );
    return cp;
  }

  async resume(checkpointId: string): Promise<Checkpoint | undefined> {
    const cp = await this.store.load(checkpointId);
    if (cp) {
      this.eventBus?.emitSync(
        makeEvent(cp.sessionId, "checkpoint.restored", { label: cp.label }),
      );
    }
    return cp;
  }

  async latestFor(sessionId: string): Promise<Checkpoint | undefined> {
    return this.store.latest(sessionId);
  }
}
