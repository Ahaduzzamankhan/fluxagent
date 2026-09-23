/**
 * FluxAgent — OpenAI-compatible BYOK provider (Phase 1).
 *
 * Works with any OpenAI-style chat-completions API (OpenAI, Azure OpenAI
 * gateways, OpenRouter, Together, Groq, vLLM, LM Studio, llama.cpp server…)
 * using user-supplied credentials. Zero dependencies: node:http(s) only.
 *
 * Features: chat, streaming (SSE), tool calling, usage metadata, timeouts,
 * caller cancellation, and normalized errors via provider-errors.ts.
 *
 * Secret handling: the API key is stored privately, sent only in the
 * Authorization header, and never logged, emitted, or embedded in errors.
 */

import * as http from "node:http";
import * as https from "node:https";

import type {
  LlmProvider,
  LlmGenerateOptions,
  PlannedPlan,
  AgentDecision,
} from "../provider.ts";
import type { LlmResponse, StreamChunk, LlmToolCall } from "../response.ts";
import type { ToolInfo } from "../../tools/tool.ts";
import { parsePlanJson, parseDecisionJson } from "../provider.ts";
import {
  ProviderError,
  providerHttpError,
  providerTransportError,
  providerResponseError,
} from "./provider-errors.ts";

export interface OpenAiCompatibleProviderOptions {
  /** Provider label used in errors/events (e.g. "openai", "openrouter"). */
  readonly providerName?: string;
  /** Base URL, e.g. https://api.openai.com/v1 (no trailing slash needed). */
  readonly baseUrl: string;
  /** User-supplied API key (BYOK). Never logged or persisted by this class. */
  readonly apiKey: string;
  readonly defaultModel: string;
  /** Request timeout in ms (default 120000). */
  readonly timeoutMs?: number;
  /** Extra headers, e.g. HTTP-Referer/X-Title for OpenRouter. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Cap on tool-call argument JSON size accepted from the model (default 1MB). */
  readonly maxToolCallBytes?: number;
}

/** OpenAI wire format for a tool the model may call. */
interface OpenAiToolSpec {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

function toWireTools(tools: readonly ToolInfo[] | undefined): OpenAiToolSpec[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/** Parse `data:` SSE lines from an OpenAI-compatible stream body. */
async function* parseSseLines(body: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer>) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data.length > 0) yield data;
      }
      // non-data lines (comments, event:, id:) are ignored
    }
  }
}

interface ChatCompletionChoiceMessage {
  readonly role?: string;
  readonly content?: string | null;
  readonly tool_calls?: readonly {
    readonly id?: string;
    readonly type?: string;
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }[];
}

interface ChatCompletionResponse {
  readonly choices?: readonly {
    readonly message?: ChatCompletionChoiceMessage;
    readonly finish_reason?: string;
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number; readonly total_tokens?: number };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly apiKey: string; // private; never logged
  private readonly timeoutMs: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly maxToolCallBytes: number;

  constructor(options: OpenAiCompatibleProviderOptions) {
    if (!options.baseUrl || !/^https?:\/\//.test(options.baseUrl)) {
      throw new Error("OpenAiCompatibleProvider: baseUrl must be an http(s) URL");
    }
    if (!options.apiKey) throw new Error("OpenAiCompatibleProvider: apiKey is required (BYOK)");
    if (!options.defaultModel) throw new Error("OpenAiCompatibleProvider: defaultModel is required");
    this.name = options.providerName ?? "openai-compatible";
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.extraHeaders = options.extraHeaders ?? {};
    this.maxToolCallBytes = options.maxToolCallBytes ?? 1_000_000;
  }

  /** Build the request body shared by generate/stream. */
  private requestBody(options: LlmGenerateOptions, stream: boolean): Record<string, unknown> {
    const messages = options.messages.map((m) => {
      if (m.role === "tool") {
        const c = m.content[0];
        const toolResult = c && c.type === "tool_result" ? c : undefined;
        return {
          role: "tool",
          tool_call_id: toolResult?.toolCallId ?? "",
          content: toolResult?.content ?? "",
        };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: m.content.find((c) => c.type === "text")?.text ?? null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        };
      }
      const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      return { role: m.role, content: text };
    });

    const body: Record<string, unknown> = {
      model: options.model ?? this.defaultModel,
      messages,
      stream,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    const tools = toWireTools(options.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  // ── transport ────────────────────────────────────────────────────────────────

  private request(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: unknown; stream?: NodeJS.ReadableStream }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}${path}`);
      const isHttps = url.protocol === "https:";
      const payload = Buffer.from(JSON.stringify(body), "utf8");
      const mod = isHttps ? https : http;
      const req = mod.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": payload.byteLength,
            Authorization: `Bearer ${this.apiKey}`, // sent, never logged
            ...this.extraHeaders,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const headers = res.headers;
          if (status >= 200 && status < 300 && body.stream === true) {
            resolve({ status, headers, json: undefined, stream: res });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.byteLength;
            if (size > 8_000_000) {
              req.destroy();
              reject(providerResponseError({ provider: this.name, message: "response body exceeds 8MB cap" }));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (status < 200 || status >= 300) {
              let parsed: unknown = raw;
              try {
                parsed = JSON.parse(raw);
              } catch {
                /* keep raw text */
              }
              reject(providerHttpError({ provider: this.name, status, body: parsed, headers }));
              return;
            }
            try {
              resolve({ status, headers, json: JSON.parse(raw) as unknown });
            } catch (e) {
              reject(providerResponseError({ provider: this.name, message: "response body is not valid JSON", cause: e }));
            }
          });
          res.on("error", (err) => reject(providerTransportError({ provider: this.name, error: err, timedOut: false })));
        },
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        reject(providerTransportError({ provider: this.name, error: new Error(`timeout after ${this.timeoutMs}ms`), timedOut: true }));
      });
      req.on("error", (err) => reject(providerTransportError({ provider: this.name, error: err, timedOut: false })));
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            req.destroy();
            reject(providerTransportError({ provider: this.name, error: new Error("caller aborted request"), timedOut: false }));
          },
          { once: true },
        );
      }
      req.end(payload);
    });
  }

  private mapResponse(json: unknown): LlmResponse {
    const parsed = json as ChatCompletionResponse;
    const choice = parsed.choices?.[0];
    if (!choice) {
      throw providerResponseError({ provider: this.name, message: "response contained no choices" });
    }
    const msg = choice.message ?? {};
    const toolCalls: LlmToolCall[] = [];
    for (const tc of msg.tool_calls ?? []) {
      const fnName = tc.function?.name;
      if (!fnName) continue;
      let args: Record<string, unknown> = {};
      const rawArgs = tc.function?.arguments;
      if (typeof rawArgs === "string" && rawArgs.length > 0) {
        if (Buffer.byteLength(rawArgs, "utf8") > this.maxToolCallBytes) {
          throw providerResponseError({
            provider: this.name,
            message: `tool call arguments exceed ${this.maxToolCallBytes} bytes (possible abuse or runaway model)`,
          });
        }
        try {
          const parsedArgs: unknown = JSON.parse(rawArgs);
          if (parsedArgs !== null && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
            args = parsedArgs as Record<string, unknown>;
          } else {
            throw new Error("arguments must be a JSON object");
          }
        } catch (e) {
          // Malformed model output is a structured failure, not a crash.
          throw providerResponseError({
            provider: this.name,
            message: `tool call \"${fnName}\" had malformed JSON arguments`,
            cause: e,
          });
        }
      }
      toolCalls.push({ id: tc.id ?? `call_${toolCalls.length}`, name: fnName, args });
    }
    const usage = parsed.usage;
    return {
      text: msg.content ?? "",
      toolCalls,
      stopReason:
        toolCalls.length > 0
          ? "tool_calls"
          : choice.finish_reason === "length"
            ? "length"
            : choice.finish_reason === "content_filter"
              ? "error"
              : "stop",
      ...(usage
        ? {
            usage: {
              promptTokens: usage.prompt_tokens ?? 0,
              completionTokens: usage.completion_tokens ?? 0,
              totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
            },
          }
        : {}),
      raw: undefined, // raw vendor payload deliberately dropped (may echo context)
    };
  }

  async generate(options: LlmGenerateOptions): Promise<LlmResponse> {
    const res = await this.request("/chat/completions", this.requestBody(options, false), options.signal);
    return this.mapResponse(res.json);
  }

  async *stream(options: LlmGenerateOptions): AsyncGenerator<StreamChunk> {
    const res = await this.request("/chat/completions", this.requestBody(options, true), options.signal);
    if (!res.stream) {
      throw providerResponseError({ provider: this.name, message: "streaming request returned no body stream" });
    }
    let finishReason: LlmResponse["stopReason"] = "stop";
    // Accumulate tool-call argument fragments keyed by index (OpenAI delta style).
    const partial = new Map<number, { id: string; name: string; args: string }>();
    for await (const data of parseSseLines(res.stream)) {
      if (data === "[DONE]") break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // skip malformed keepalives
      }
      const chunk = parsed as {
        choices?: readonly { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
      };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) yield { type: "text", value: choice.delta.content };
      for (const tc of choice.delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const slot = partial.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        partial.set(idx, slot);
      }
      if (choice.finish_reason) {
        finishReason =
          choice.finish_reason === "tool_calls"
            ? "tool_calls"
            : choice.finish_reason === "length"
              ? "length"
              : choice.finish_reason === "content_filter"
                ? "error"
                : "stop";
      }
    }
    for (const slot of partial.values()) {
      let args: Record<string, unknown> = {};
      try {
        args = slot.args ? (JSON.parse(slot.args) as Record<string, unknown>) : {};
      } catch (e) {
        throw providerResponseError({
          provider: this.name,
          message: `streamed tool call \"${slot.name}\" had malformed JSON arguments`,
          cause: e,
        });
      }
      yield { type: "tool_call", call: { id: slot.id, name: slot.name, args } };
    }
    yield { type: "done", finishReason };
  }

  // ── composition methods (plan/decide via JSON prompts) ──────────────────────

  async plan(options: { goal: string; availableTools: readonly ToolInfo[]; context?: string; signal?: AbortSignal }): Promise<PlannedPlan> {
    const { buildPlanMessages } = await import("../provider.ts");
    const res = await this.generate({
      messages: buildPlanMessages(options.goal, options.availableTools, options.context),
      signal: options.signal,
    });
    try {
      return parsePlanJson(res.text);
    } catch (e) {
      throw providerResponseError({
        provider: this.name,
        message: "model did not return a parseable plan JSON object",
        cause: e,
      });
    }
  }

  async decideTool(options: {
    goal: string;
    planSummary: string;
    recentObservations: readonly string[];
    availableTools: readonly ToolInfo[];
    signal?: AbortSignal;
  }): Promise<AgentDecision> {
    const { buildDecideMessages } = await import("../provider.ts");
    const res = await this.generate({
      messages: buildDecideMessages(options.goal, options.planSummary, options.recentObservations, options.availableTools),
      signal: options.signal,
    });
    try {
      return parseDecisionJson(res.text);
    } catch (e) {
      throw providerResponseError({
        provider: this.name,
        message: "model did not return a parseable decision JSON object",
        cause: e,
      });
    }
  }
}
