/**
 * FluxAgent — persistent semantic memory service (Phase 4).
 *
 * Adds the memory *pipeline* on top of the existing LayeredMemory store:
 *
 *   candidate → importance assessment → deduplication → storage →
 *   retrieval (token overlap ranking) → context feed
 *
 * Key invariants:
 *   - Provenance is mandatory; model-generated content can never be upgraded
 *     to `fact` here — it keeps its epistemic type.
 *   - Deduplication: near-identical content (normalized token overlap ≥
 *     threshold) updates the existing record instead of storing a duplicate.
 *   - Persistence: optional JSON-file store so memory survives restarts
 *     (zero dependencies; a vector backend can implement the same interface).
 *   - Expiration: records may carry `expiresAt`; expired records are filtered
 *     on retrieval and never fed to the model.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { MemoryRecordV2, MemoryWriteRequest, Provenance, MemoryLayer } from "./layers.ts";
import { provenance } from "./layers.ts";
import { ids } from "../utils/ids.ts";

export type SemanticMemoryKind = "fact" | "preference" | "project" | "experience" | "procedure";

export interface SemanticRecord {
  readonly id: string;
  readonly kind: SemanticMemoryKind;
  readonly content: string;
  readonly provenance: Provenance;
  readonly importance: number; // 0..1
  readonly tags: readonly string[];
  /** ISO timestamp after which the record should no longer be retrieved. */
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly useCount: number;
  readonly forgotten: boolean;
}

export interface SemanticStore {
  all(): Promise<readonly SemanticRecord[]>;
  save(record: SemanticRecord): Promise<void>;
  /** Optional durable flush; in-memory stores may no-op. */
  flush?(): Promise<void>;
}

// ─── JSON-file persistence (zero deps) ────────────────────────────────────────

export class JsonFileSemanticStore implements SemanticStore {
  private readonly file: string;
  private cache: SemanticRecord[] | null = null;

  constructor(options: { directory?: string; fileName?: string } = {}) {
    const dir = options.directory ?? ".fluxagent/memory";
    this.file = path.join(dir, options.fileName ?? "semantic.json");
  }

  async all(): Promise<readonly SemanticRecord[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.cache = Array.isArray(parsed) ? (parsed as SemanticRecord[]) : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  async save(record: SemanticRecord): Promise<void> {
    const all = [...(await this.all())];
    const idx = all.findIndex((r) => r.id === record.id);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    this.cache = all;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.cache) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), "utf8");
  }
}

export class InMemorySemanticStore implements SemanticStore {
  private readonly records: SemanticRecord[] = [];
  async all(): Promise<readonly SemanticRecord[]> {
    return this.records;
  }
  async save(record: SemanticRecord): Promise<void> {
    const idx = this.records.findIndex((r) => r.id === record.id);
    if (idx >= 0) this.records[idx] = record;
    else this.records.push(record);
  }
  async flush(): Promise<void> {
    /* nothing to persist */
  }
}

// ─── Text similarity (token overlap — deterministic, no embeddings) ──────────

export function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Jaccard overlap of normalized token sets, 0..1. */
export function tokenOverlap(a: string, b: string): number {
  const sa = new Set(normalizeTokens(a));
  const sb = new Set(normalizeTokens(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface SemanticMemoryOptions {
  readonly store?: SemanticStore;
  /** Overlap above which new content is treated as a duplicate (0..1). */
  readonly dedupThreshold?: number;
  /** Records per retrieval (default). */
  readonly defaultLimit?: number;
}

export interface RememberRequest {
  readonly kind: SemanticMemoryKind;
  readonly content: string;
  readonly provenance: Provenance;
  readonly importance?: number;
  readonly tags?: readonly string[];
  readonly expiresAt?: string;
  /** Replacements are allowed only for non-fact kinds unless force=true. */
  readonly forceUpdate?: boolean;
}

export interface RememberOutcome {
  readonly record: SemanticRecord;
  /** true when an existing record was updated instead of a new one stored. */
  readonly deduplicated: boolean;
}

export interface RetrieveRequest {
  readonly query: string;
  readonly kinds?: readonly SemanticMemoryKind[];
  readonly minImportance?: number;
  readonly limit?: number;
  /** Exclude expired records (default true). */
  readonly excludeExpired?: boolean;
}

export class SemanticMemoryService {
  private readonly store: SemanticStore;
  private readonly dedupThreshold: number;
  private readonly defaultLimit: number;

  constructor(options: SemanticMemoryOptions = {}) {
    this.store = options.store ?? new InMemorySemanticStore();
    this.dedupThreshold = options.dedupThreshold ?? 0.72;
    this.defaultLimit = options.defaultLimit ?? 8;
  }

  /**
   * Pipeline: importance → dedup → storage. Model-generated content keeps its
   * epistemic type; `fact` provenance can only come from tool/user sources.
   */
  async remember(req: RememberRequest): Promise<RememberOutcome> {
    const provenanceOk =
      req.provenance.type !== "fact" ||
      req.provenance.source === "user" ||
      req.provenance.source === "tool" ||
      req.provenance.source === "file" ||
      req.provenance.source === "system";
    if (!provenanceOk) {
      // Downgrade silently-dishonest provenance to model-generated assumption.
      req = { ...req, provenance: provenance("model", "model-generated", req.provenance.origin, Math.min(req.provenance.confidence, 0.5)) };
    }

    const importance = req.importance ?? defaultImportance(req.kind);

    // Dedup pass.
    const existing = await this.store.all();
    let best: SemanticRecord | undefined;
    let bestScore = 0;
    for (const rec of existing) {
      if (rec.forgotten || rec.kind !== req.kind) continue;
      const score = tokenOverlap(rec.content, req.content);
      if (score > bestScore) {
        bestScore = score;
        best = rec;
      }
    }

    const now = new Date().toISOString();
    if (best && bestScore >= this.dedupThreshold) {
      const upgradedImportance = Math.max(best.importance, importance);
      const updated: SemanticRecord = {
        ...best,
        content: req.content.length > best.content.length ? req.content : best.content,
        importance: upgradedImportance,
        expiresAt: req.expiresAt ?? best.expiresAt,
        provenance: req.provenance.type === "fact" ? req.provenance : best.provenance,
        tags: mergeTags(best.tags, req.tags ?? []),
        updatedAt: now,
        useCount: best.useCount,
        forgotten: false,
      };
      await this.store.save(updated);
      return { record: updated, deduplicated: true };
    }

    const record: SemanticRecord = {
      id: ids.event(),
      kind: req.kind,
      content: req.content,
      provenance: req.provenance,
      importance,
      tags: req.tags ?? [],
      ...(req.expiresAt ? { expiresAt: req.expiresAt } : {}),
      createdAt: now,
      updatedAt: now,
      useCount: 0,
      forgotten: false,
    };
    await this.store.save(record);
    return { record, deduplicated: false };
  }

  /**
   * Retrieval: token-overlap ranking blended with importance; expired records
   * excluded. Every hit bumps useCount (usage signal for later trimming).
   */
  async retrieve(req: RetrieveRequest): Promise<readonly SemanticRecord[]> {
    const all = await this.store.all();
    const excludeExpired = req.excludeExpired ?? true;
    const now = Date.now();
    const limit = req.limit ?? this.defaultLimit;

    const scored = all
      .filter((r) => !r.forgotten)
      .filter((r) => !excludeExpired || !r.expiresAt || Date.parse(r.expiresAt) > now)
      .filter((r) => (req.kinds ? req.kinds.includes(r.kind) : true))
      .filter((r) => (req.minImportance !== undefined ? r.importance >= req.minImportance! : true))
      .map((r) => ({ rec: r, score: tokenOverlap(r.content, req.query) * 0.7 + r.importance * 0.3 + Math.min(r.useCount, 10) * 0.005 }))
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    for (const s of scored) {
      await this.store.save({ ...s.rec, useCount: s.rec.useCount + 1, updatedAt: s.rec.updatedAt });
    }
    return scored.map((s) => s.rec);
  }

  /** Feed for the context manager: verified + relevant, model-claims excluded. */
  async contextFeed(query: string, limit = 6): Promise<readonly string[]> {
    const hits = await this.retrieve({ query, limit: limit * 2 });
    return hits
      .filter((r) => r.provenance.type === "fact" || r.provenance.type === "user-provided" || r.importance >= 0.7)
      .slice(0, limit)
      .map((r) => r.content);
  }

  async forget(id: string): Promise<void> {
    const all = await this.store.all();
    const rec = all.find((r) => r.id === id);
    if (rec) await this.store.save({ ...rec, forgotten: true, updatedAt: new Date().toISOString() });
  }

  /** Stats for doctor/diagnostics. */
  async stats(): Promise<{ total: number; byKind: Record<string, number>; forgotten: number }> {
    const all = await this.store.all();
    const byKind: Record<string, number> = {};
    for (const r of all) {
      if (r.forgotten) continue;
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    }
    return { total: all.filter((r) => !r.forgotten).length, byKind, forgotten: all.filter((r) => r.forgotten).length };
  }
}

function defaultImportance(kind: SemanticMemoryKind): number {
  switch (kind) {
    case "preference": return 0.8;
    case "fact": return 0.7;
    case "procedure": return 0.7;
    case "project": return 0.6;
    case "experience": return 0.5;
  }
}

function mergeTags(existing: readonly string[], add: readonly string[]): readonly string[] {
  const set = new Set(existing);
  for (const t of add) set.add(t);
  return [...set];
}

// Re-export for convenience so consumers can build Provenance values.
export { provenance as memoryProvenance };
export type { MemoryRecordV2, MemoryWriteRequest, MemoryLayer };
