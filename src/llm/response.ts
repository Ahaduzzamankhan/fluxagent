/**
 * FluxAgent — LLM response types (provider-neutral).
 */

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface LlmResponse {
  /** Text content (may be empty when the model only requested tools). */
  readonly text: string;
  /** Tool calls requested by the model, if any. */
  readonly toolCalls: readonly LlmToolCall[];
  readonly stopReason: "stop" | "tool_calls" | "length" | "error";
  readonly usage?: TokenUsage;
  readonly raw?: unknown;
}

/** Piece of a streamed response. */
export type StreamChunk =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "tool_call"; readonly call: LlmToolCall }
  | { readonly type: "done"; readonly finishReason: LlmResponse["stopReason"] };

export interface LlmStreamHandle {
  /** Async iterable of chunks; completes after `done`. */
  readonly stream: AsyncIterable<StreamChunk>;
  cancel(): void;
}

export function emptyResponse(text = ""): LlmResponse {
  return { text, toolCalls: [], stopReason: "stop" };
}
