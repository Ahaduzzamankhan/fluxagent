/**
 * FluxAgent — short-term (in-process) memory.
 *
 * Bounded ring-buffer style stores for the current session: conversation
 * turns, recent observations, current plan reference. JSON-safe only.
 */

import type {
  ConversationTurn,
  ShortTermMemory,
} from "./memory.ts";
import type { Observation } from "../agent/state.ts";

export interface ShortTermMemoryOptions {
  readonly maxMessages?: number;
  readonly maxObservations?: number;
  readonly observationTruncationLength?: number;
}

export class InMemoryShortTermMemory implements ShortTermMemory {
  private readonly messages: ConversationTurn[] = [];
  private readonly observations: Observation[] = [];
  private planRef: string | null = null;
  private readonly maxMessages: number;
  private readonly maxObservations: number;
  private readonly truncLen: number;

  constructor(options: ShortTermMemoryOptions = {}) {
    this.maxMessages = options.maxMessages ?? 200;
    this.maxObservations = options.maxObservations ?? 100;
    this.truncLen = options.observationTruncationLength ?? 4000;
  }

  pushMessage(turn: ConversationTurn): void {
    this.messages.push(turn);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }
  }

  getMessages(limit?: number): readonly ConversationTurn[] {
    const out = [...this.messages];
    return limit ? out.slice(-limit) : out;
  }

  pushObservation(obs: Observation): void {
    const trimmed = truncateObservation(obs, this.truncLen);
    this.observations.push(trimmed);
    if (this.observations.length > this.maxObservations) {
      this.observations.splice(0, this.observations.length - this.maxObservations);
    }
  }

  recentObservations(limit?: number): readonly Observation[] {
    const out = [...this.observations];
    return limit ? out.slice(-limit) : out;
  }

  setCurrentPlanRef(planId: string | null): void {
    this.planRef = planId;
  }

  currentPlanRef(): string | null {
    return this.planRef;
  }

  clear(): void {
    this.messages.length = 0;
    this.observations.length = 0;
    this.planRef = null;
  }
}

/**
 * Cap serialized observation size so state stays bounded.
 * Deep-truncates long string fields instead of slicing JSON text, so the
 * result always stays valid JSON.
 */
function truncateObservation(obs: Observation, maxLen: number): Observation {
  if (obs.output === undefined) return obs;
  let json: string;
  try {
    json = JSON.stringify(obs.output);
  } catch {
    return { ...obs, output: "[unserializable output]" };
  }
  if (json.length <= maxLen) return obs;
  const budget = Math.max(16, Math.floor(maxLen / 4));
  return {
    ...obs,
    output: truncateStrings(obs.output, budget),
    notes: `${obs.notes ? obs.notes + " " : ""}[truncated]`,
  };
}

function truncateStrings(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    return value.length <= max ? value : `${value.slice(0, max)}…[${value.length - max} chars]`;
  }
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, max));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateStrings(v, max);
    }
    return out;
  }
  return value;
}
