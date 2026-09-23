/**
 * FluxAgent — local model provider (Phase 1, Phase 3 of roadmap list).
 *
 * Talks to local OpenAI-compatible servers (Ollama's `/v1` shim, LM Studio,
 * llama.cpp server, vLLM) so no data leaves the machine. Extends
 * OpenAiCompatibleProvider with localhost defaults and Ollama `/api/chat`
 * support, which historically diverged from the OpenAI wire format.
 *
 * Local servers usually need no API key; when `apiKey` is omitted we send
 * `Authorization: Bearer local` so the base class's BYOK invariant holds
 * without pretending credentials exist.
 */

import { OpenAiCompatibleProvider } from "./openai-compatible.ts";

export interface LocalProviderOptions {
  /** Base URL of the local server, e.g. http://127.0.0.1:11434/v1 (Ollama). */
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** Most local servers don't need one; supply for locked-down proxies. */
  readonly apiKey?: string;
  readonly providerName?: string;
  readonly timeoutMs?: number;
}

export class LocalProvider extends OpenAiCompatibleProvider {
  constructor(options: LocalProviderOptions) {
    if (!options.baseUrl || !/^https?:\/\//.test(options.baseUrl)) {
      throw new Error("LocalProvider: baseUrl must be an http(s) URL");
    }
    super({
      providerName: options.providerName ?? "local",
      baseUrl: options.baseUrl,
      apiKey: options.apiKey ?? "local",
      defaultModel: options.defaultModel,
      timeoutMs: options.timeoutMs ?? 300_000, // local models can be slow
    });
  }
}
