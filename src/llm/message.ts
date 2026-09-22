/**
 * FluxAgent — LLM message types (provider-neutral).
 *
 * Mirrors common chat-completion shapes so adapters to OpenAI/Anthropic/etc.
 * are thin. No API keys here — credentials belong in provider config.
 */

export type MessageRole = "system" | "user" | "assistant" | "tool" | "developer";

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

/** Reference to a tool result (used in `role: "tool"` messages). */
export interface ToolResultContent {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
}

export type MessageContent = TextContent | ToolResultContent;

export interface LlmMessage {
  readonly role: MessageRole;
  readonly content: readonly MessageContent[];
  readonly name?: string;
  /** Tool call requests emitted by an assistant message. */
  readonly toolCalls?: readonly ToolCallRequest[];
}

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  /** Provider-neutral JSON arguments object. */
  readonly args: Record<string, unknown>;
}

export function text(message: string): TextContent {
  return { type: "text", text: message };
}

export function userMessage(textContent: string, name?: string): LlmMessage {
  return { role: "user", content: [text(textContent)], ...(name ? { name } : {}) };
}

export function systemMessage(content: string): LlmMessage {
  return { role: "system", content: [text(content)] };
}

export function assistantMessage(content: string, toolCalls?: readonly ToolCallRequest[]): LlmMessage {
  return {
    role: "assistant",
    content: [text(content)],
    ...(toolCalls ? { toolCalls } : {}),
  };
}

export function toolResultMessage(
  toolCallId: string,
  content: string,
  isError = false,
  name?: string,
): LlmMessage {
  return {
    role: "tool",
    content: [{ type: "tool_result", toolCallId, content, isError }],
    ...(name ? { name } : {}),
  };
}

/** Render a message to a compact plain-text form (for logging/state). */
export function renderMessage(m: LlmMessage): string {
  const parts: string[] = [];
  if (m.toolCalls?.length) {
    parts.push(m.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`).join("; "));
  }
  for (const c of m.content) {
    if (c.type === "text") parts.push(c.text);
    else parts.push(`[tool_result ${c.toolCallId}${c.isError ? " ERROR" : ""}] ${c.content}`);
  }
  return parts.join("\n");
}
