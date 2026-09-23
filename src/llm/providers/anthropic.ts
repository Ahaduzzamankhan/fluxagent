/**
 * FluxAgent — Anthropic Messages-API provider (Phase 1).
 *
 * BYOK adapter over api.anthropic.com's /v1/messages using node:https.
 * Maps FluxAgent's neutral message/tool shapes onto Anthropic's content
 * blocks (tool_use / tool_result) and back. Zero dependencies.
 *
 * Secret handling: `x-api-key` header only; the key never appears in
 * errors, logs, or events.
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
  providerHttpError,
  providerTransportError,
  providerResponseError,
  type ProviderError,
} from "./provider-errors.ts";

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly baseUrl?: string; // default https://api.anthropic.com
  /** Anthropic API version header value. */
  readonly version?: string;
  readonly timeoutMs?: number;
  readonly maxTokensDefault?: number;
}

interface AnthropicToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
}

type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string; readonly is_error?: boolean };

interface AnthropicRequestMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly AnthropicContentBlock[];
}

function toAnthropicTools(tools: readonly ToolInfo[] | undefined): AnthropicToolSpec[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

/** Convert neutral messages to Anthropic messages (system extracted). */
function toAnthropicMessages(options: LlmGenerateOptions): { system?: string; messages: AnthropicRequestMessage[] } {
  let system: string | undefined;
  const messages: AnthropicRequestMessage[] = [];
  for (const m of options.messages) {
    if (m.role === "system" || m.role === "developer") {
      const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      system = system ? `${system}\n${text}` : text;
      continue;
    }
    if (m.role === "tool") {
      const c = m.content[0];
      const tr = c && c.type === "tool_result" ? c : undefined;
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: tr?.toolCallId ?? "",
            content: tr?.content ?? "",
            ...(tr?.isError ? { is_error: true } : {}),
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      if (text) blocks.push({ type: "text", text });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      }
      if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
      continue;
    }
    // user
    const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    messages.push({ role: "user", content: [{ type: "text", text }] });
  }
  return { ...(system !== undefined ? { system } : {}), messages };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly defaultModel: string;
  private readonly apiKey: string; // private; never logged
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly timeoutMs: number;
  private readonly maxTokensDefault: number;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) throw new Error("AnthropicProvider: apiKey is required (BYOK)");
    if (!options.defaultModel) throw new Error("AnthropicProvider: defaultModel is required");
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.version = options.version ?? "2023-06-01";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxTokensDefault = options.maxTokensDefault ?? 4096;
  }

  private requestBody(options: LlmGenerateOptions, stream: boolean): Record<string, unknown> {
    const { system, messages } = toAnthropicMessages(options);
    const body: Record<string, unknown> = {
      model: options.model ?? this.defaultModel,
      max_tokens: options.maxTokens ?? this.maxTokensDefault,
      messages,
      stream,
    };
    if (system !== undefined) body.system = system;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    const tools = toAnthropicTools(options.tools);
    if (tools) body.tools = tools;
    return body;
  }

  private request(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json?: unknown; stream?: NodeJS.ReadableStream }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/v1/messages`);
      const payload = Buffer.from(JSON.stringify(body), "utf8");
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": payload.byteLength,
            "x-api-key": this.apiKey, // sent, never logged
            "anthropic-version": this.version,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const headers = res.headers;
          if (status >= 200 && status < 300 && body.stream === true) {
            resolve({ status, headers, stream: res });
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (status < 200 || status >= 300) {
              let parsed: unknown = raw;
              try {
                parsed = JSON.parse(raw);
              } catch {
                /* keep raw */
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
    const parsed = json as {
      content?: readonly AnthropicContentBlock[];
      stop_reason?: string;
      usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
    };
    if (!Array.isArray(parsed.content)) {
      throw providerResponseError({ provider: this.name, message: "response missing content blocks" });
    }
    let text = "";
    const toolCalls: LlmToolCall[] = [];
    for (const block of parsed.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        const input = block.input;
        if (input !== null && typeof input === "object" && !Array.isArray(input)) {
          toolCalls.push({ id: block.id, name: block.name, args: input as Record<string, unknown> });
        } else {
          throw providerResponseError({
            provider: this.name,
            message: `tool_use block \"${block.name}\" has non-object input`,
          });
        }
      }
    }
    const usage = parsed.usage;
    return {
      text,
      toolCalls,
      stopReason:
        parsed.stop_reason === "tool_use"
          ? "tool_calls"
          : parsed.stop_reason === "max_tokens"
            ? "length"
            : parsed.stop_reason === "refusal"
              ? "error"
              : "stop",
      ...(usage
        ? {
            usage: {
              promptTokens: usage.input_tokens ?? 0,
              completionTokens: usage.output_tokens ?? 0,
              totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            },
          }
        : {}),
    };
  }

  async generate(options: LlmGenerateOptions): Promise<LlmResponse> {
    const res = await this.request(this.requestBody(options, false), options.signal);
    return this.mapResponse(res.json);
  }

  async *stream(options: LlmGenerateOptions): AsyncGenerator<StreamChunk> {
    const res = await this.request(this.requestBody(options, true), options.signal);
    if (!res.stream) throw providerResponseError({ provider: this.name, message: "streaming request returned no body" });
    let finishReason: LlmResponse["stopReason"] = "stop";
    // Accumulate tool_use input_json deltas by block index.
    const partial = new Map<number, { id: string; name: string; json: string }>();
    let currentTool: { index: number; id: string; name: string } | null = null;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.stream as AsyncIterable<Uint8Array | Buffer>) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let evt: unknown;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        const ev = evt as { type?: string; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }; content_block?: { type?: string; id?: string; name?: string }; index?: number };
        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          currentTool = { index: ev.index ?? 0, id: ev.content_block.id ?? `call_${ev.index ?? 0}`, name: ev.content_block.name ?? "" };
          partial.set(ev.index ?? 0, { id: currentTool.id, name: currentTool.name, json: "" });
        } else if (ev.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta" && ev.delta.text) yield { type: "text", value: ev.delta.text };
          if (ev.delta?.type === "input_json_delta" && ev.delta.partial_json !== undefined) {
            const slot = partial.get(ev.index ?? currentTool?.index ?? 0);
            if (slot) slot.json += ev.delta.partial_json;
          }
        } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
          finishReason =
            ev.delta.stop_reason === "tool_use"
              ? "tool_calls"
              : ev.delta.stop_reason === "max_tokens"
                ? "length"
                : "stop";
        }
      }
    }
    for (const slot of partial.values()) {
      let args: Record<string, unknown> = {};
      try {
        args = slot.json ? (JSON.parse(slot.json) as Record<string, unknown>) : {};
      } catch (e) {
        throw providerResponseError({
          provider: this.name,
          message: `streamed tool_use \"${slot.name}\" had malformed JSON input`,
          cause: e,
        });
      }
      yield { type: "tool_call", call: { id: slot.id, name: slot.name, args } };
    }
    yield { type: "done", finishReason };
  }

  async plan(options: { goal: string; availableTools: readonly ToolInfo[]; context?: string; signal?: AbortSignal }): Promise<PlannedPlan> {
    const { buildPlanMessages } = await import("../provider.ts");
    const res = await this.generate({
      messages: buildPlanMessages(options.goal, options.availableTools, options.context),
      signal: options.signal,
    });
    try {
      return parsePlanJson(res.text);
    } catch (e) {
      throw providerResponseError({ provider: this.name, message: "model did not return a parseable plan JSON object", cause: e });
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
      throw providerResponseError({ provider: this.name, message: "model did not return a parseable decision JSON object", cause: e });
    }
  }
}

// Re-export for gateway consumers type-referencing.
export type { ProviderError };
