/**
 * FluxAgent — multi-layer memory with provenance.
 *
 * Layers:
 *   working    — current-task scratch state (in-process, volatile)
 *   episodic   — what happened during tasks (observations, decisions)
 *   semantic   — facts about the world (user-provided, tool-derived, learned)
 *   procedural — how to do things (successful step patterns, tool preferences)
 *   conversation — existing ConversationMemory (memory/conversation.ts)
 *
 * Every record carries provenance: where it came from (user | tool | model |
 * file | memory | system | previous-task) and its epistemic type (fact |
 * observation | assumption | model-generated | user-provided). The brain must
 * not treat model-generated content as fact.
 */

import type { Observation } from "../agent/state.ts";
import { ids } from "../utils/ids.ts";

// ─── Provenance ───────────────────────────────────────────────────────────────

export type MemorySource = "user" | "tool" | "model" | "file" | "memory" | "system" | "previous-task";

export type MemoryEpistemicType =
  | "fact"
  | "observation"
  | "assumption"
  | "model-generated"
  | "user-provided";

export interface Provenance {
  readonly source: MemorySource;
  readonly type: MemoryEpistemicType;
  /** What produced this (tool name, model id, file path...). */
  readonly origin?: string;
  /** Confidence 0..1 — model-generated content must not exceed its true basis. */
  readonly confidence: number;
}

export function provenance(
  source: MemorySource,
  type: MemoryEpistemicType,
  origin?: string,
  confidence = 1,
): Provenance {
  return { source, type, ...(origin ? { origin } : {}), confidence };
}

// ─── Record shape ─────────────────────────────────────────────────────────────

export interface MemoryRecordV2 {
  readonly id: string;
  readonly layer: MemoryLayer;
  readonly content: string;
  readonly structured?: Readonly<Record<string, unknown>>;
  readonly provenance: Provenance;
  readonly importance: number; // 0..1
  readonly tags: readonly string[];
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Soft-delete marker; forgotten records are filtered, not lost. */
  readonly forgotten: boolean;
}

export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural";

export interface MemoryWriteRequest {
  readonly layer: MemoryLayer;
  readonly content: string;
  readonly structured?: Record<string, unknown>;
  readonly provenance: Provenance;
  readonly importance?: number;
  readonly tags?: readonly string[];
  readonly taskId?: string;
  readonly sessionId?: string;
}

export interface MemorySearchRequest {
  readonly query?: string;
  readonly layers?: readonly MemoryLayer[];
  readonly tags?: readonly string[];
  readonly minImportance?: number;
  readonly types?: readonly MemoryEpistemicType[];
  readonly taskId?: string;
  readonly limit?: number;
  /** Include forgotten records (default false). */
  readonly includeForgotten?: boolean;
}

// ─── Store interface (vector backend can implement this later) ────────────────

export interface LayeredMemoryStore {
  write(req: MemoryWriteRequest): Promise<MemoryRecordV2>;
  search(req: MemorySearchRequest): Promise<readonly MemoryRecordV2[]>;
  get(id: string): Promise<MemoryRecordV2 | undefined>;
  update(id: string, patch: { content?: string; importance?: number; tags?: readonly string[]; forgotten?: boolean }): Promise<MemoryRecordV2 | undefined>;
  forget(id: string): Promise<void>;
  /** Bounded history per layer to keep memory finite. */
  trim(layer: MemoryLayer, keep: number): Promise<number>;
}

// ─── In-memory implementation ─────────────────────────────────────────────────

export interface InMemoryLayeredStoreOptions {
  /** Max records per layer (oldest, lowest-importance trimmed first). */
  readonly maxPerLayer?: number;
}

export class InMemoryLayeredStore implements LayeredMemoryStore {
  private readonly records: MemoryRecordV2[] = [];
  private readonly maxPerLayer: number;

  constructor(options: InMemoryLayeredStoreOptions = {}) {
    this.maxPerLayer = options.maxPerLayer ?? 500;
  }

  async write(req: MemoryWriteRequest): Promise<MemoryRecordV2> {
    const now = new Date().toISOString();
    const rec: MemoryRecordV2 = {
      id: ids.event(),
      layer: req.layer,
      content: req.content,
      ...(req.structured ? { structured: req.structured } : {}),
      provenance: req.provenance,
      importance: req.importance ?? 0.5,
      tags: req.tags ?? [],
      ...(req.taskId ? { taskId: req.taskId } : {}),
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      createdAt: now,
      updatedAt: now,
      forgotten: false,
    };
    this.records.push(rec);
    await this.trim(req.layer, this.maxPerLayer);
    return rec;
  }

  async search(req: MemorySearchRequest): Promise<readonly MemoryRecordV2[]> {
    let out = this.records.filter((r) => !r.forgotten || req.includeForgotten);
    if (req.layers?.length) out = out.filter((r) => req.layers!.includes(r.layer));
    if (req.tags?.length) out = out.filter((r) => req.tags!.some((t) => r.tags.includes(t)));
    if (req.types?.length) out = out.filter((r) => req.types!.includes(r.provenance.type));
    if (req.minImportance !== undefined) out = out.filter((r) => r.importance >= req.minImportance!);
    if (req.taskId) out = out.filter((r) => r.taskId === req.taskId);
    if (req.query) {
      const q = req.query.toLowerCase();
      out = out.filter((r) => r.content.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)));
    }
    out = out.sort((a, b) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt));
    return req.limit ? out.slice(0, req.limit) : out;
  }

  async get(id: string): Promise<MemoryRecordV2 | undefined> {
    return this.records.find((r) => r.id === id);
  }

  async update(
    id: string,
    patch: { content?: string; importance?: number; tags?: readonly string[]; forgotten?: boolean },
  ): Promise<MemoryRecordV2 | undefined> {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return undefined;
    const updated: MemoryRecordV2 = {
      ...rec,
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
      ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
      ...(patch.forgotten !== undefined ? { forgotten: patch.forgotten } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.records[this.records.indexOf(rec)] = updated;
    return updated;
  }

  async forget(id: string): Promise<void> {
    await this.update(id, { forgotten: true });
  }

  async trim(layer: MemoryLayer, keep: number): Promise<number> {
    const inLayer = this.records
      .filter((r) => r.layer === layer && !r.forgotten)
      .sort((a, b) => a.importance - b.importance || a.createdAt.localeCompare(b.createdAt));
    let trimmed = 0;
    for (let i = 0; i < inLayer.length - keep; i++) {
      const rec = inLayer[i]!;
      this.records[this.records.indexOf(rec)] = { ...rec, forgotten: true };
      trimmed++;
    }
    return trimmed;
  }
}

// ─── Layered memory facade ────────────────────────────────────────────────────

export interface LayeredMemoryOptions {
  readonly store?: LayeredMemoryStore;
  readonly sessionId?: string;
}

export class LayeredMemory {
  private readonly store: LayeredMemoryStore;
  private readonly working = new Map<string, string>();
  private readonly sessionId?: string;

  constructor(options: LayeredMemoryOptions = {}) {
    this.store = options.store ?? new InMemoryLayeredStore();
    this.sessionId = options.sessionId;
  }

  /** Working memory: immediate scratch values for the current task. */
  setWorking(key: string, value: string): void {
    this.working.set(key, value);
  }
  getWorking(key: string): string | undefined {
    return this.working.get(key);
  }
  clearWorking(): void {
    this.working.clear();
  }
  workingKeys(): readonly string[] {
    return [...this.working.keys()];
  }

  /** Record what happened (episodic). */
  async recordEpisode(input: {
    summary: string;
    observation?: Observation;
    taskId?: string;
    importance?: number;
    tags?: readonly string[];
  }): Promise<MemoryRecordV2> {
    return this.store.write({
      layer: "episodic",
      content: input.summary,
      structured: input.observation
        ? { toolName: input.observation.toolName, ok: input.observation.ok, callId: input.observation.callId }
        : undefined,
      provenance: provenance("tool", "observation", input.observation?.toolName, input.observation?.ok ? 1 : 0.9),
      importance: input.importance ?? (input.observation?.ok ? 0.4 : 0.8),
      tags: ["episode", ...(input.tags ?? [])],
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
  }

  /** Store a fact (semantic) — provenance REQUIRED, assumptions stay assumptions. */
  async rememberFact(input: {
    content: string;
    provenance: Provenance;
    importance?: number;
    tags?: readonly string[];
    taskId?: string;
  }): Promise<MemoryRecordV2> {
    return this.store.write({
      layer: "semantic",
      content: input.content,
      provenance: input.provenance,
      importance: input.importance ?? 0.6,
      tags: ["fact", ...(input.tags ?? [])],
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
  }

  /** Store a successful how-to pattern (procedural). */
  async rememberProcedure(input: {
    description: string;
    structured?: Record<string, unknown>;
    importance?: number;
    tags?: readonly string[];
  }): Promise<MemoryRecordV2> {
    return this.store.write({
      layer: "procedural",
      content: input.description,
      structured: input.structured,
      provenance: provenance("previous-task", "fact", "execution-history"),
      importance: input.importance ?? 0.7,
      tags: ["procedure", ...(input.tags ?? [])],
    });
  }

  /** Search across layers. */
  async search(req: MemorySearchRequest = {}): Promise<readonly MemoryRecordV2[]> {
    return this.store.search(req);
  }

  /** Facts only, typed as such — the safe feed for the context manager. */
  async verifiedFacts(limit = 10): Promise<readonly MemoryRecordV2[]> {
    return this.store.search({
      layers: ["semantic"],
      types: ["fact", "user-provided"],
      limit,
    });
  }

  async forget(id: string): Promise<void> {
    await this.store.forget(id);
  }
}

/** Derive a procedural memory from a successful step sequence. */
export function procedureFromSteps(steps: readonly { title: string; tool: string | null }[]): string {
  return steps.map((s) => (s.tool ? `${s.title} [${s.tool}]` : s.title)).join(" → ");
}
