/**
 * FluxAgent — provider registry + config factory (Phase 1).
 *
 * Creates provider adapters from user configuration (BYOK: keys come from
 * the environment or config the user supplies). The factory never persists
 * or logs credentials.
 *
 * Supported config shapes (config.llm.providerOptions):
 *
 *   openai-compatible / openai:
 *     { baseUrl, apiKey | apiKeyEnv, model, timeoutMs?, extraHeaders? }
 *   anthropic:
 *     { apiKey | apiKeyEnv, model, timeoutMs? }
 *   local:
 *     { baseUrl, model, timeoutMs? }   // Ollama/LM Studio/llama.cpp
 *
 * `apiKeyEnv` names an environment variable holding the secret — the
 * recommended BYOK flow. Raw `apiKey` values are also accepted for
 * programmatic use and never logged.
 */

import type { LlmProvider } from "../provider.ts";
import { OpenAiCompatibleProvider } from "./openai-compatible.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { LocalProvider } from "./local.ts";

export type ProviderKind = "openai-compatible" | "openai" | "anthropic" | "local" | "mock";

export function isProviderKind(v: unknown): v is ProviderKind {
  return v === "openai-compatible" || v === "openai" || v === "anthropic" || v === "local" || v === "mock";
}

/** Resolve a secret from options: explicit apiKey, or env var named by apiKeyEnv. */
function resolveApiKey(opts: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof opts.apiKey === "string" && opts.apiKey.length > 0) return opts.apiKey;
  if (typeof opts.apiKeyEnv === "string" && opts.apiKeyEnv.length > 0) {
    const fromEnv = process.env[opts.apiKeyEnv];
    if (fromEnv && fromEnv.length > 0) return fromEnv;
  }
  return undefined;
}

function requireString(opts: Readonly<Record<string, unknown>>, key: string, what: string): string {
  const v = opts[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${what}: "${key}" must be a non-empty string`);
  }
  return v;
}

/**
 * Build a provider from config. Throws plain Errors with actionable
 * messages; never includes resolved secret values in the error text.
 */
export function createProviderFromOptions(kind: ProviderKind, providerOptions: Readonly<Record<string, unknown>>): LlmProvider {
  switch (kind) {
    case "mock":
      // Imported lazily to avoid a cycle in test-only builds.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      throw new Error("mock providers are constructed directly (new MockLlmProvider())");
    case "openai":
    case "openai-compatible": {
      const baseUrl = requireString(providerOptions, "baseUrl", kind);
      const apiKey = resolveApiKey(providerOptions);
      if (!apiKey) {
        throw new Error(
          `${kind}: no API key — set providerOptions.apiKeyEnv to the env var holding your key (recommended) or providerOptions.apiKey`,
        );
      }
      return new OpenAiCompatibleProvider({
        providerName: kind === "openai" ? "openai" : "openai-compatible",
        baseUrl,
        apiKey,
        defaultModel: requireString(providerOptions, "model", kind),
        ...(typeof providerOptions.timeoutMs === "number" ? { timeoutMs: providerOptions.timeoutMs } : {}),
        ...(providerOptions.extraHeaders && typeof providerOptions.extraHeaders === "object"
          ? { extraHeaders: providerOptions.extraHeaders as Record<string, string> }
          : {}),
      });
    }
    case "anthropic": {
      const apiKey = resolveApiKey(providerOptions);
      if (!apiKey) {
        throw new Error("anthropic: no API key — set providerOptions.apiKeyEnv (e.g. \"ANTHROPIC_API_KEY\") or providerOptions.apiKey");
      }
      return new AnthropicProvider({
        apiKey,
        defaultModel: requireString(providerOptions, "model", "anthropic"),
        ...(typeof providerOptions.baseUrl === "string" ? { baseUrl: providerOptions.baseUrl } : {}),
        ...(typeof providerOptions.timeoutMs === "number" ? { timeoutMs: providerOptions.timeoutMs } : {}),
      });
    }
    case "local": {
      return new LocalProvider({
        baseUrl: requireString(providerOptions, "baseUrl", "local"),
        defaultModel: requireString(providerOptions, "model", "local"),
        ...(resolveApiKey(providerOptions) ? { apiKey: resolveApiKey(providerOptions)! } : {}),
        ...(typeof providerOptions.timeoutMs === "number" ? { timeoutMs: providerOptions.timeoutMs } : {}),
      });
    }
  }
}
