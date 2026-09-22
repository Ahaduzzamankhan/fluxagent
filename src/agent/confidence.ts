/**
 * FluxAgent — confidence system (Phase 6.5).
 *
 * Confidence is METADATA, never truth. Every estimate carries its basis so
 * consumers can weight it appropriately. Estimates from different subsystems
 * (planning, tool selection, verification, completion) use the same scale
 * (0..1) and the same provenance shape.
 *
 * Rules:
 *  - a confidence value must always be paired with its basis;
 *  - combining confidences can only reduce or keep confidence (multiplicative
 *    blending with the weakest link dominating);
 *  - nothing in the runtime treats high confidence as "skip verification".
 */

export type ConfidenceBasis =
  | "verified" // backed by a formal verification verdict
  | "observed" // backed by direct observation
  | "heuristic" // computed from deterministic rules
  | "model-reported" // produced by an LLM — lowest weight
  | "historical"; // backed by recorded past outcomes

const BASIS_WEIGHT: Readonly<Record<ConfidenceBasis, number>> = {
  verified: 1,
  observed: 0.85,
  historical: 0.7,
  heuristic: 0.6,
  "model-reported": 0.3,
};

export interface ConfidenceEstimate {
  /** 0..1 — informational only. */
  readonly value: number;
  readonly basis: ConfidenceBasis;
  /** What produced this estimate (rule name, model id, verdict id...). */
  readonly origin: string;
  /** Weighted value = value * basis weight; how much to trust it. */
  readonly weight: number;
  readonly at: string;
}

export function confidence(
  value: number,
  basis: ConfidenceBasis,
  origin: string,
): ConfidenceEstimate {
  const clamped = Math.min(1, Math.max(0, value));
  return {
    value: clamped,
    basis,
    origin,
    weight: Math.round(clamped * BASIS_WEIGHT[basis] * 100) / 100,
    at: new Date().toISOString(),
  };
}

/**
 * Combine several estimates. The blend is multiplicative across weighted
 * values but floor-bounded by the strongest single estimate — combining
 * conflicting evidence lowers confidence; agreeing evidence approaches the
 * best basis. Deterministic.
 */
export function combineConfidence(estimates: readonly ConfidenceEstimate[]): ConfidenceEstimate {
  if (estimates.length === 0) {
    return confidence(0, "heuristic", "no-evidence");
  }
  const geometric = estimates.reduce((acc, e) => acc * Math.max(0.05, e.weight), 1) ** (1 / estimates.length);
  const strongest = Math.max(...estimates.map((e) => e.weight));
  const value = Math.round(((geometric + strongest) / 2) * 100) / 100;
  const best = [...estimates].sort((a, b) => BASIS_WEIGHT[b.basis] - BASIS_WEIGHT[a.basis])[0]!;
  return confidence(value, best.basis, `combined(${estimates.length})`);
}

/** Historical success rate → historical-basis confidence. */
export function fromSuccessRate(successes: number, total: number, origin: string): ConfidenceEstimate {
  if (total <= 0) return confidence(0.5, "historical", `${origin}:no-data`);
  return confidence(successes / total, "historical", `${origin}:${successes}/${total}`);
}

/** Label helper for UIs — never used for control flow decisions alone. */
export function confidenceLabel(c: ConfidenceEstimate): "low" | "medium" | "high" {
  return c.weight < 0.4 ? "low" : c.weight < 0.75 ? "medium" : "high";
}
