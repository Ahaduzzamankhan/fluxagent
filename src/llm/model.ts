/**
 * FluxAgent — model descriptor + capability-based routing input.
 */

export type ModelCapability =
  | "text"
  | "tool-use"
  | "vision"
  | "long-context"
  | "fast"
  | "reasoning";

export interface ModelDescriptor {
  /** Globally unique id, e.g. "openai:gpt-4o" or "mock:deterministic". */
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly capabilities: readonly ModelCapability[];
  /** Relative 1..10 quality for routing decisions. */
  readonly quality: number;
  /** Relative cost score 1..10 (10 = most expensive). */
  readonly cost: number;
  readonly maxInputTokens: number;
}

export interface RoutingConstraints {
  readonly needsTools?: boolean;
  readonly needsVision?: boolean;
  readonly maxCost?: number; // 1..10
  readonly minQuality?: number; // 1..10
  readonly preferFast?: boolean;
}

/** Selects a model id given candidates + constraints. Deterministic. */
export type ModelRouter = (
  candidates: readonly ModelDescriptor[],
  constraints: RoutingConstraints,
) => ModelDescriptor | undefined;

export const defaultModelRouter: ModelRouter = (candidates, constraints) => {
  const eligible = candidates.filter((m) => {
    if (constraints.needsTools && !m.capabilities.includes("tool-use")) return false;
    if (constraints.needsVision && !m.capabilities.includes("vision")) return false;
    if (constraints.maxCost !== undefined && m.cost > constraints.maxCost) return false;
    if (constraints.minQuality !== undefined && m.quality < constraints.minQuality) return false;
    return true;
  });
  if (eligible.length === 0) return undefined;
  const fastBias = constraints.preferFast ? 2 : 0;
  return [...eligible].sort((a, b) => score(b, fastBias) - score(a, fastBias))[0];
};

function score(m: ModelDescriptor, fastBias: number): number {
  // Higher is better: quality dominates, cost penalized, speed tie-break.
  return m.quality * 10 - m.cost + fastBias;
}
