/**
 * FluxAgent — native tool-calling loop (Phase 2).
 *
 * Drives a conversation with a tool-use-capable model:
 *
 *   LLM → tool call → parse → schema validation → permission check →
 *   ToolRegistry.execute → structured result → observation → next LLM turn
 *
 * Security invariants:
 *   - The model NEVER executes anything directly; every call goes through
 *     ToolRegistry.execute (the single execution path).
 *   - Unknown tools, malformed arguments, and denials become structured
 *     tool results fed BACK to the model — never thrown away or faked.
 *   - Tool output size is capped before it re-enters model context.
 *   - Permission checks ride the PermissionManager; denials are not retried.
 */

import { ids } from "../utils/ids.ts";
import { validateAgainstSchema } from "../tools/schemas.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { PermissionManager } from "../security/permission-manager.ts";
import type { EventBus } from "../events/event-bus.ts";
import { makeEvent } from "../events/events.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { LlmMessage, ToolCallRequest } from "../llm/message.ts";
import { assistantMessage, toolResultMessage } from "../llm/message.ts";
import type { Logger } from "../utils/logger.ts";
import type { Observation } from "./state.ts";

export interface ToolLoopOptions {
  readonly goal: string;
  readonly registry: ToolRegistry;
  readonly permissions: PermissionManager;
  readonly provider: LlmProvider;
  readonly eventBus?: EventBus;
  readonly logger?: Logger;
  /** Model turns before giving up (prevents runaway loops). */
  readonly maxTurns?: number;
  /** Cap on each serialized tool result fed back to the model (chars). */
  readonly maxToolResultChars?: number;
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
}

export interface ToolLoopStep {
  readonly callId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly ok: boolean;
  /** Structured result or error JSON as delivered to the model. */
  readonly resultForModel: string;
  readonly observation: Observation;
}

export interface ToolLoopResult {
  readonly status: "completed" | "max_turns" | "cancelled";
  readonly text: string;
  readonly steps: readonly ToolLoopStep[];
  readonly turns: number;
}

/** Serialize a tool execution result for the model (bounded). */
function serializeToolResult(result: unknown, maxChars: number): string {
  let s: string;
  try {
    s = JSON.stringify(result) ?? "null";
  } catch {
    s = String(result);
  }
  if (s.length > maxChars) {
    return `${s.slice(0, maxChars)}…[truncated ${s.length - maxChars} chars]`;
  }
  return s;
}

export class ToolCallingLoop {
  /**
   * Run the tool-calling conversation until the model stops with a text
   * answer, the turn budget is exhausted, or cancellation fires.
   */
  async run(options: ToolLoopOptions): Promise<ToolLoopResult> {
    const maxTurns = options.maxTurns ?? 12;
    const maxResultChars = options.maxToolResultChars ?? 8000;
    const sessionId = `loop_${ids.session()}`;
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: [
          {
            type: "text",
            text:
              options.systemPrompt ??
              "You are FluxAgent's native tool-calling engine. Use the provided tools to accomplish the goal. " +
              "Prefer few, precise calls. Stop (no tool call) when the goal is achieved and summarize.",
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: options.goal }] },
    ];

    const steps: ToolLoopStep[] = [];
    const tools = options.registry.list();

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (options.signal?.aborted) {
        return { status: "cancelled", text: "", steps, turns: turn };
      }

      const response = await options.provider.generate({ messages, tools, signal: options.signal });

      if (response.toolCalls.length === 0) {
        return { status: "completed", text: response.text, steps, turns: turn };
      }

      // Assistant turn (with its tool calls) must precede the tool results.
      const calls: ToolCallRequest[] = response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args }));
      messages.push(assistantMessage(response.text, calls));

      for (const call of calls) {
        const result = await this.executeCall(call, options, sessionId, maxResultChars);
        steps.push(result);
        messages.push(
          toolResultMessage(call.id, result.resultForModel, !result.ok, call.name),
        );
      }
    }

    return { status: "max_turns", text: "", steps, turns: maxTurns };
  }

  /** One tool call: parse → validate → permission → execute → observation. */
  private async executeCall(
    call: ToolCallRequest,
    options: ToolLoopOptions,
    sessionId: string,
    maxResultChars: number,
  ): Promise<ToolLoopStep> {
    const { registry, permissions } = options;
    options.eventBus?.emitSync(
      makeEvent(sessionId, "tool.called", { toolName: call.name, callId: call.id, args: call.args }),
    );

    const tool = registry.get(call.name);
    if (!tool) {
      const resultForModel = JSON.stringify({
        ok: false,
        error: { code: "E_TOOL_NOT_FOUND", message: `Unknown tool "${call.name}". Use one of the provided tools.` },
      });
      options.eventBus?.emitSync(
        makeEvent(sessionId, "tool.failed", { toolName: call.name, callId: call.id, reason: "unknown tool" }),
      );
      // Observation with a synthetic error.
      const observation: Observation = {
        id: ids.observation(),
        sessionId,
        toolName: call.name,
        callId: call.id,
        ok: false,
        error: { name: "FluxError", code: "E_TOOL_NOT_FOUND", message: `tool ${call.name} not registered`, details: {} },
        durationMs: 0,
        at: new Date().toISOString(),
      };
      return { callId: call.id, toolName: call.name, args: call.args, ok: false, resultForModel, observation };
    }

    // 1) Schema validation BEFORE anything executes.
    const validation = validateAgainstSchema<Record<string, unknown>>(tool.metadata.inputSchema, call.args);
    if (!validation.valid) {
      const resultForModel = JSON.stringify({
        ok: false,
        error: { code: "E_TOOL_ARGUMENTS_INVALID", message: `Invalid arguments: ${validation.issues.join("; ")}` },
      });
      options.eventBus?.emitSync(
        makeEvent(sessionId, "tool.failed", { toolName: call.name, callId: call.id, reason: validation.issues.join("; ") }),
      );
      const observation: Observation = {
        id: ids.observation(),
        sessionId,
        toolName: call.name,
        callId: call.id,
        ok: false,
        error: { name: "FluxError", code: "E_TOOL_ARGUMENTS_INVALID", message: validation.issues.join("; "), details: { issues: validation.issues } },
        durationMs: 0,
        at: new Date().toISOString(),
      };
      return { callId: call.id, toolName: call.name, args: call.args, ok: false, resultForModel, observation };
    }

    // 2) Permission gate — denials are structured results fed back to the model.
    const allowed = await permissions.authorize({ tool: tool.metadata, args: validation.value });
    const execution = await registry.execute({
      toolName: call.name,
      args: validation.value,
      ...(allowed ? {} : { checkPermission: async () => false }),
    });

    const resultForModel = serializeToolResult(
      execution.ok ? { ok: true, result: execution.output } : { ok: false, error: execution.error },
      maxResultChars,
    );
    options.eventBus?.emitSync(
      execution.ok
        ? makeEvent(sessionId, "tool.completed", { toolName: call.name, callId: call.id, ok: true })
        : makeEvent(sessionId, "tool.failed", { toolName: call.name, callId: call.id, reason: execution.error?.message ?? "failed" }),
    );

    const observation: Observation = {
      id: ids.observation(),
      sessionId,
      toolName: call.name,
      callId: execution.callId,
      ok: execution.ok,
      ...(execution.ok ? { output: execution.output } : {}),
      error: execution.error ?? null,
      durationMs: execution.durationMs,
      at: new Date().toISOString(),
    };
    return {
      callId: call.id,
      toolName: call.name,
      args: call.args,
      ok: execution.ok,
      resultForModel,
      observation,
    };
  }
}
