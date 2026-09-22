/**
 * FluxAgent — model router service v2 (Phase 6.2).
 *
 * Provider-independent routing with:
 *  - task classification (purpose × complexity → constraints)
 *  - capability matching (text/tool-use/vision/embedding/long-context)
 *  - model health tracking (failure counts, circuit-breaker style open state)
 *  - latency metadata (rolling average, feeds selection)
 *  - fallback chains (primary → alternates ordered by score)
 *
 * Deterministic scoring; no fake "AI routing". Extends ModelRouterService
 * (kept intact for backward compatibility) with health/fallback data.
 */

import type { ModelDescriptor, ModelCapability, RoutingConstraints } from "./model.ts";
import { defaultModelRouter } from "./model.ts";

export type TaskComplexity = "simple" | "moderate" | "complex";

export interface RouteRequest {
  readonly purpose: "plan" | "decide" | "summarize" | "vision" | "generate" | "embed" | "code";
  readonly complexity: TaskComplexity;
  readonly needsVision?: boolean;
  readonly needsTools?: boolean;
  readonly needsEmbedding?: boolean;
  /** Approximate input size in chars; large inputs prefer long-context models. */
  readonly approxInputChars?: number;
  /** Hard requirement: only this model id (used by pinned sessions). */
  readonly pinnedModelId?: string;
}

export interface RouterOptions {
  /** Preference weights per purpose; defaults are sensible. */
  readonly preferFastForSimple?: boolean;
  /** Consecutive failures before a model is considered unhealthy. */
  readonly healthFailureThreshold?: number;
  /** Ms before an unhealthy model is probed again. */
  readonly healthResetMs?: number;
}

interface ModelHealth {
  failures: number;
  successes: number;
  latencyMsAvg: number | null;
  latencySamples: number;
  openedAt: number | null;
}

const EMPTY_HEALTH: ModelHealth = { failures: 0, successes: 0, latencyMsAvg: null, latencySamples: 0, openedAt: null };

export interface RouteCandidate {
  readonly model: ModelDescriptor;
  readonly score: number;
  readonly healthy: boolean;
}

export class ModelRouterService {
  private readonly models = new Map<string, ModelDescriptor>();
  private readonly health = new Map<string, ModelHealth>();
  private readonly preferFastForSimple: boolean;
  private readonly failureThreshold: number;
  private readonly healthResetMs: number;

  constructor(options: RouterOptions = {}) {
    this.preferFastForSimple = options.preferFastForSimple ?? true;
    this.failureThreshold = options.healthFailureThreshold ?? 3;
    this.healthResetMs = options.healthResetMs ?? 60_000;
  }

  registerModel(descriptor: ModelDescriptor): void {
    this.models.set(descriptor.id, descriptor);
  }

  registerModels(descriptors: readonly ModelDescriptor[]): void {
    for (const d of descriptors) this.registerModel(d);
  }

  listModels(): readonly ModelDescriptor[] {
    return [...this.models.values()];
  }

  // ── health tracking ────────────────────────────────────────────────────────

  recordSuccess(modelId: string, latencyMs?: number): void {
    const h = this.health.get(modelId) ?? { ...EMPTY_HEALTH };
    h.failures = 0;
    h.openedAt = null;
    h.successes += 1;
    if (latencyMs !== undefined && latencyMs >= 0) {
      h.latencyMsAvg = h.latencyMsAvg === null ? latencyMs : Math.round((h.latencyMsAvg * 0.7 + latencyMs * 0.3));
      h.latencySamples += 1;
    }
    this.health.set(modelId, h);
  }

  recordFailure(modelId: string): void {
    const h = this.health.get(modelId) ?? { ...EMPTY_HEALTH };
    h.failures += 1;
    if (h.failures >= this.failureThreshold) h.openedAt = Date.now();
    this.health.set(modelId, h);
  }

  /** A model is unhealthy after N consecutive failures until the reset window passes. */
  isHealthy(modelId: string): boolean {
    const h = this.health.get(modelId);
    if (!h || h.openedAt === null) return true;
    if (Date.now() - h.openedAt >= this.healthResetMs) {
      // Half-open: allow one probe by clearing the open state.
      h.openedAt = null;
      h.failures = 0;
      this.health.set(modelId, h);
      return true;
    }
    return false;
  }

  healthSnapshot(modelId: string): Readonly<{ failures: number; successes: number; latencyMsAvg: number | null }> {
    const h = this.health.get(modelId) ?? EMPTY_HEALTH;
    return { failures: h.failures, successes: h.successes, latencyMsAvg: h.latencyMsAvg };
  }

  // ── selection ──────────────────────────────────────────────────────────────

  /** Translate a route request into routing constraints and select a model. */
  select(request: RouteRequest): ModelDescriptor | undefined {
    if (request.pinnedModelId) return this.models.get(request.pinnedModelId);

    const constraints = this.constraintsFor(request);
    const approx = request.approxInputChars ?? 0;
    const pool = approx > 60_000
      ? this.modelsList().filter((m) => m.capabilities.includes("long-context"))
      : this.modelsList();

    const ranked = this.rank(pool, constraints, request);
    return ranked[0]?.model;
  }

  /**
   * Full fallback chain: healthy candidates ordered by fit; unhealthy models
   * appended after healthy ones (still usable as last resort).
   */
  routeWithFallbacks(request: RouteRequest): readonly RouteCandidate[] {
    if (request.pinnedModelId) {
      const m = this.models.get(request.pinnedModelId);
      return m ? [{ model: m, score: 0, healthy: this.isHealthy(m.id) }] : [];
    }
    const constraints = this.constraintsFor(request);
    const approx = request.approxInputChars ?? 0;
    const pool = approx > 60_000
      ? this.modelsList().filter((m) => m.capabilities.includes("long-context"))
      : this.modelsList();
    return this.rank(pool, constraints, request);
  }

  /** Select a model or fall back to the single best registered one. */
  selectOrDefault(request: RouteRequest): ModelDescriptor | undefined {
    return this.select(request) ?? this.modelsList().sort((a, b) => b.quality - a.quality)[0];
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private constraintsFor(request: RouteRequest): RoutingConstraints {
    return {
      needsTools: request.needsTools ?? (request.purpose === "plan" || request.purpose === "decide" || request.purpose === "code"),
      needsVision: request.needsVision ?? request.purpose === "vision",
      preferFast:
        request.complexity === "simple" && this.preferFastForSimple
          ? true
          : request.purpose === "summarize",
      minQuality: request.complexity === "complex" ? 7 : undefined,
      maxCost: request.complexity === "simple" ? 6 : undefined,
    };
  }

  private rank(pool: readonly ModelDescriptor[], constraints: RoutingConstraints, request: RouteRequest): readonly RouteCandidate[] {
    if (request.needsEmbedding || request.purpose === "embed") {
      // Embedding requests prefer models advertising the embedding capability.
      const embedCapable = pool.filter((m) => (m.capabilities as readonly string[]).includes("embedding"));
      return this.scored(embedCapable.length > 0 ? embedCapable : pool, constraints, request);
    }
    // Text-only work must not land on a dedicated embedding model.
    const textPool = pool.filter((m) => !(m.capabilities as readonly string[]).includes("embedding"));
    return this.scored(textPool.length > 0 ? textPool : pool, constraints, request);
  }

  private scored(pool: readonly ModelDescriptor[], constraints: RoutingConstraints, request: RouteRequest): RouteCandidate[] {
    const fastBias = constraints.preferFast ? 2 : 0;
    const scoredModels = pool
      .map((m) => {
        let s = m.quality * 10 - m.cost + fastBias;
        if (request.complexity === "simple" && m.capabilities.includes("fast")) s += 3;
        if (request.purpose === "code" && m.capabilities.includes("reasoning")) s += 2;
        // Latency-aware nudge: faster models win ties.
        const h = this.health.get(m.id);
        if (h?.latencyMsAvg != null) s -= Math.min(3, h.latencyMsAvg / 3000);
        const healthy = this.isHealthy(m.id);
        if (!healthy) s -= 100; // deprioritize but keep as last resort
        return { model: m, score: Math.round(s * 100) / 100, healthy };
      })
      .sort((a, b) => b.score - a.score);

    // Capability hard filters via defaultModelRouter first: if it picks a
    // HEALTHY model, put it first (it satisfies the constraints). Unhealthy
    // models keep their health penalty — they are fallbacks, not preferences.
    const preferred = defaultModelRouter(
      pool.filter((m) => this.isHealthy(m.id)),
      constraints,
    );
    if (preferred) {
      const idx = scoredModels.findIndex((c) => c.model.id === preferred.id);
      if (idx > 0) {
        const [picked] = scoredModels.splice(idx, 1);
        scoredModels.unshift(picked!);
      }
    }
    return scoredModels;
  }

  private modelsList(): ModelDescriptor[] {
    return [...this.models.values()];
  }
}

/** Convenience: build a descriptor for the built-in mock provider. */
export function mockModelDescriptor(): ModelDescriptor {
  return {
    id: "mock:deterministic",
    provider: "mock",
    name: "deterministic-scripted",
    capabilities: ["text", "tool-use"],
    quality: 1,
    cost: 1,
    maxInputTokens: 100_000,
  };
}

export type { ModelCapability };
