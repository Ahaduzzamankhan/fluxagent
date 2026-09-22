/**
 * FluxAgent — model gateway (Phase 8.2).
 *
 * A unified, provider-independent gateway over LlmProvider implementations.
 * The brain calls the gateway; the gateway routes (via ModelRouterService),
 * dispatches to a provider adapter, records health, and normalizes results.
 *
 * Capabilities are detected per provider (chat, stream, embed, vision,
 * tool-calling, structured output) so clients can query before calling.
 */

import type { LlmProvider, LlmGenerateOptions } from "../llm/provider.ts";
import type { LlmResponse, StreamChunk } from "../llm/response.ts";
import type { ModelDescriptor } from "../llm/model.ts";
import type { ModelRouterService, RouteRequest } from "../llm/router.ts";
import type { ExecutionLedger } from "../agent/execution-ledger.ts";
import type { Logger } from "../utils/logger.ts";
import { executeReliably, type ReliableExecution } from "../runtime/reliability.ts";

export type GatewayCapability =
  | "chat"
  | "stream"
  | "generate"
  | "embed"
  | "vision"
  | "tool-calling"
  | "structured-output";

export interface GatewayDispatchOptions extends LlmGenerateOptions {
  readonly purpose?: RouteRequest["purpose"];
  readonly complexity?: RouteRequest["complexity"];
  readonly approxInputChars?: number;
  readonly needsVision?: boolean;
  readonly needsTools?: boolean;
  readonly pinnedModelId?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

export interface GatewayDispatchResult {
  readonly response: LlmResponse;
  readonly modelId: string;
  readonly provider: string;
  readonly attempts: number;
  readonly degraded: boolean;
  readonly latencyMs: number;
}

export class ModelGateway {
  private readonly providers = new Map<string, LlmProvider>();
  private readonly router: ModelRouterService;
  private readonly ledger?: ExecutionLedger;
  private readonly logger?: Logger;

  constructor(options: {
    router: ModelRouterService;
    ledger?: ExecutionLedger;
    logger?: Logger;
  }) {
    this.router = options.router;
    this.ledger = options.ledger;
    this.logger = options.logger;
  }

  /** Register a provider adapter; its default model is registered in the router. */
  registerProvider(provider: LlmProvider, descriptor?: ModelDescriptor): void {
    this.providers.set(provider.name, provider);
    const d = descriptor ?? {
      id: `${provider.name}:${provider.defaultModel}`,
      provider: provider.name,
      name: provider.defaultModel,
      capabilities: inferProviderCapabilities(provider),
      quality: 5,
      cost: 5,
      maxInputTokens: 100_000,
    };
    this.router.registerModel(d);
  }

  listProviders(): readonly string[] {
    return [...this.providers.keys()];
  }

  /** Capability detection for a provider, from its declared interface. */
  capabilitiesFor(providerName: string): readonly GatewayCapability[] {
    const p = this.providers.get(providerName);
    if (!p) return [];
    return inferProviderCapabilities(p);
  }

  /**
   * Dispatch a chat/generate request: route → resolve provider → execute
   * reliably (retry + timeout) → record health + ledger outcome.
   */
  async dispatch(options: GatewayDispatchOptions): Promise<GatewayDispatchResult> {
    const request: RouteRequest = {
      purpose: options.purpose ?? "generate",
      complexity: options.complexity ?? "moderate",
      needsVision: options.needsVision,
      needsTools: options.needsTools ?? (options.tools !== undefined && options.tools.length > 0),
      approxInputChars: options.approxInputChars ?? estimateChars(options.messages),
      pinnedModelId: options.pinnedModelId,
    };

    const chain = this.router.routeWithFallbacks(request);
    if (chain.length === 0) {
      throw Object.assign(new Error("no models registered in the gateway"), { code: "E_LLM_UNAVAILABLE" });
    }

    let lastError: unknown;
    for (const candidate of chain) {
      const provider = this.providers.get(candidate.model.provider);
      if (!provider) {
        lastError = new Error(`no provider adapter for "${candidate.model.provider}"`);
        continue;
      }
      const startedAt = Date.now();
      try {
        const execution: ReliableExecution<LlmResponse> = await executeReliably(
          async (signal) => provider.generate({ ...options, signal, model: options.model ?? candidate.model.name }),
          {
            operation: `gateway:${candidate.model.id}`,
            timeoutMs: options.timeoutMs,
            maxAttempts: options.maxAttempts ?? 2,
            baseDelayMs: 300,
          },
        );
        const latencyMs = Date.now() - startedAt;
        this.router.recordSuccess(candidate.model.id, latencyMs);
        this.ledger?.recordModelOutcome(candidate.model.id, true, latencyMs);
        this.logger?.debug("gateway dispatch ok", { model: candidate.model.id, latencyMs });
        return {
          response: execution.value,
          modelId: candidate.model.id,
          provider: candidate.model.provider,
          attempts: execution.attempts,
          degraded: execution.degraded || candidate.model.id !== chain[0]!.model.id,
          latencyMs,
        };
      } catch (err) {
        lastError = err;
        this.router.recordFailure(candidate.model.id);
        this.ledger?.recordModelOutcome(candidate.model.id, false, Date.now() - startedAt);
        this.logger?.warn("gateway dispatch failed", {
          model: candidate.model.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Streaming dispatch: picks a model (healthy first) and returns the
   * provider's stream. Health is recorded optimistically; consumers should
   * report failures via recordFailure when consuming throws.
   */
  async *stream(options: GatewayDispatchOptions): AsyncGenerator<StreamChunk & { modelId?: string }> {
    const request: RouteRequest = {
      purpose: options.purpose ?? "generate",
      complexity: options.complexity ?? "moderate",
      needsTools: options.needsTools,
      approxInputChars: options.approxInputChars ?? estimateChars(options.messages),
      pinnedModelId: options.pinnedModelId,
    };
    const chain = this.router.routeWithFallbacks(request);
    let picked: { model: ModelDescriptor; provider: LlmProvider } | null = null;
    for (const candidate of chain) {
      const provider = this.providers.get(candidate.model.provider);
      if (provider) {
        picked = { model: candidate.model, provider };
        break;
      }
    }
    if (!picked) throw Object.assign(new Error("no provider adapter available for stream"), { code: "E_LLM_UNAVAILABLE" });

    const startedAt = Date.now();
    for await (const chunk of picked.provider.stream({ ...options, model: options.model ?? picked.model.name })) {
      yield { ...chunk, modelId: picked.model.id };
    }
    this.router.recordSuccess(picked.model.id, Date.now() - startedAt);
    this.ledger?.recordModelOutcome(picked.model.id, true, Date.now() - startedAt);
  }
}

function estimateChars(messages: readonly unknown[]): number {
  try {
    return JSON.stringify(messages).length;
  } catch {
    return 0;
  }
}

/** Infer gateway capabilities from what the provider implements/exposes. */
function inferProviderCapabilities(provider: LlmProvider): readonly GatewayCapability[] {
  const caps: GatewayCapability[] = ["generate", "chat"];
  if (typeof provider.stream === "function") caps.push("stream");
  const proto = provider as unknown as { embed?: unknown; supportsVision?: unknown; supportsTools?: unknown; structuredOutput?: unknown };
  if (typeof proto.embed === "function") caps.push("embed");
  if (proto.supportsVision === true) caps.push("vision");
  if (proto.supportsTools !== false) caps.push("tool-calling");
  if (proto.structuredOutput === true) caps.push("structured-output");
  return caps;
}
