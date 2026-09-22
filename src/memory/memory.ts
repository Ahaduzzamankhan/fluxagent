/**
 * FluxAgent — memory interfaces.
 *
 * Interfaces only here; concrete stores live in short-term.ts / long-term.ts.
 * A vector database can be added later by implementing `VectorMemory` — the
 * agent only consumes `MemoryManager`.
 */

import type { Observation } from "../agent/state.ts";
import type { LlmMessage } from "../llm/message.ts";

export interface ConversationTurn {
  readonly role: "user" | "agent" | "system";
  readonly content: string;
  readonly at: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ShortTermMemory {
  pushMessage(turn: ConversationTurn): void;
  getMessages(limit?: number): readonly ConversationTurn[];
  pushObservation(obs: Observation): void;
  recentObservations(limit?: number): readonly Observation[];
  setCurrentPlanRef(planId: string | null): void;
  currentPlanRef(): string | null;
  clear(): void;
}

export interface MemoryRecord {
  readonly key: string;
  readonly value: unknown;
  readonly kind: "fact" | "task" | "preference" | "skill" | "note";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tags?: readonly string[];
}

export interface MemoryQuery {
  readonly text?: string;
  readonly tags?: readonly string[];
  readonly kinds?: readonly MemoryRecord["kind"][];
  readonly limit?: number;
}

export interface LongTermMemory {
  put(record: Omit<MemoryRecord, "createdAt" | "updatedAt">): Promise<MemoryRecord>;
  get(key: string): Promise<MemoryRecord | undefined>;
  query(q: MemoryQuery): Promise<readonly MemoryRecord[]>;
  delete(key: string): Promise<void>;
  /** Persist a finished task outcome for future planning context. */
  recordTaskOutcome(outcome: {
    goal: string;
    success: boolean;
    summary: string;
    stepsTaken: number;
  }): Promise<void>;
}

/** Optional vector-backed recall. Implement later (e.g. sqlite-vec, Qdrant). */
export interface VectorMemory {
  upsert(id: string, vector: readonly number[], payload?: Readonly<Record<string, unknown>>): Promise<void>;
  search(vector: readonly number[], topK: number): Promise<readonly { id: string; score: number; payload?: Record<string, unknown> }[]>;
  delete(id: string): Promise<void>;
}

/** Embeddings provider seam (Python bridge implements this later). */
export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

export class MemoryManager {
  readonly shortTerm: ShortTermMemory;
  readonly longTerm: LongTermMemory;
  readonly vector?: VectorMemory;

  constructor(shortTerm: ShortTermMemory, longTerm: LongTermMemory, vector?: VectorMemory) {
    this.shortTerm = shortTerm;
    this.longTerm = longTerm;
    this.vector = vector;
  }
}
