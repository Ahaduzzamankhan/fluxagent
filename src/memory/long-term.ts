/**
 * FluxAgent — long-term memory backends.
 *
 * `JsonFileLongTermMemory` persists records to a JSON file; no vector DB
 * required. A `VectorMemory` can be composed later behind the same interface.
 *
 * TODO(dependency): a SQLite/vector backend can be added later behind the same
 * `LongTermMemory` interface.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { LongTermMemory, MemoryRecord, MemoryQuery } from "./memory.ts";

export class MemoryKeyNotFoundError extends Error {
  constructor(key: string) {
    super(`Memory key not found: ${key}`);
    this.name = "MemoryKeyNotFoundError";
  }
}

export interface JsonFileLongTermMemoryOptions {
  readonly directory?: string;
  readonly fileName?: string;
}

export class JsonFileLongTermMemory implements LongTermMemory {
  private readonly file: string;
  private cache: Map<string, MemoryRecord> | null = null;

  constructor(options: JsonFileLongTermMemoryOptions = {}) {
    const dir = options.directory ?? ".fluxagent/memory";
    this.file = path.join(dir, options.fileName ?? "long-term.json");
  }

  async put(record: Omit<MemoryRecord, "createdAt" | "updatedAt">): Promise<MemoryRecord> {
    const store = await this.load();
    const now = new Date().toISOString();
    const existing = store.get(record.key);
    const full: MemoryRecord = {
      ...record,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    store.set(full.key, full);
    await this.save(store);
    return full;
  }

  async get(key: string): Promise<MemoryRecord | undefined> {
    const store = await this.load();
    return store.get(key);
  }

  async query(q: MemoryQuery): Promise<readonly MemoryRecord[]> {
    const store = await this.load();
    let out = [...store.values()];
    if (q.kinds?.length) out = out.filter((r) => q.kinds!.includes(r.kind));
    if (q.tags?.length) {
      out = out.filter((r) => (r.tags ?? []).some((t) => q.tags!.includes(t)));
    }
    if (q.text) {
      const needle = q.text.toLowerCase();
      out = out.filter((r) => JSON.stringify(r.value).toLowerCase().includes(needle));
    }
    if (q.limit) out = out.slice(0, q.limit);
    return out;
  }

  async delete(key: string): Promise<void> {
    const store = await this.load();
    store.delete(key);
    await this.save(store);
  }

  async recordTaskOutcome(outcome: {
    goal: string;
    success: boolean;
    summary: string;
    stepsTaken: number;
  }): Promise<void> {
    await this.put({
      key: `task:${new Date().toISOString()}`,
      kind: "task",
      value: outcome,
      tags: ["task-outcome", outcome.success ? "success" : "failure"],
    });
  }

  private async load(): Promise<Map<string, MemoryRecord>> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const map = new Map<string, MemoryRecord>();
      if (Array.isArray(parsed)) {
        for (const rec of parsed as MemoryRecord[]) map.set(rec.key, rec);
      }
      this.cache = map;
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }

  private async save(store: Map<string, MemoryRecord>): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify([...store.values()], null, 2), "utf8");
  }
}

// ─── In-memory backend (tests / ephemeral runs) ───────────────────────────────

export class InMemoryLongTermMemory implements LongTermMemory {
  private readonly store = new Map<string, MemoryRecord>();

  async put(record: Omit<MemoryRecord, "createdAt" | "updatedAt">): Promise<MemoryRecord> {
    const now = new Date().toISOString();
    const existing = this.store.get(record.key);
    const full: MemoryRecord = {
      ...record,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.set(full.key, full);
    return full;
  }

  async get(key: string): Promise<MemoryRecord | undefined> {
    return this.store.get(key);
  }

  async query(q: MemoryQuery): Promise<readonly MemoryRecord[]> {
    let out = [...this.store.values()];
    if (q.kinds?.length) out = out.filter((r) => q.kinds!.includes(r.kind));
    if (q.tags?.length) out = out.filter((r) => (r.tags ?? []).some((t) => q.tags!.includes(t)));
    if (q.text) {
      const needle = q.text.toLowerCase();
      out = out.filter((r) => JSON.stringify(r.value).toLowerCase().includes(needle));
    }
    if (q.limit) out = out.slice(0, q.limit);
    return out;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async recordTaskOutcome(outcome: {
    goal: string;
    success: boolean;
    summary: string;
    stepsTaken: number;
  }): Promise<void> {
    await this.put({
      key: `task:${new Date().toISOString()}`,
      kind: "task",
      value: outcome,
      tags: ["task-outcome", outcome.success ? "success" : "failure"],
    });
  }
}
