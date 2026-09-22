/**
 * FluxAgent — Tool contract.
 *
 * A Tool is a *controlled capability*: named, described, schema-validated,
 * permission-gated, and executed against injected controllers. The agent never
 * receives raw functions — only what is registered here.
 */

import type { PermissionLevel } from "./permissions.ts";
import type { JSONSchema } from "./schemas.ts";

/** Serializable descriptor surfaced to the LLM/UI. */
export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly permissionLevel: PermissionLevel;
  readonly tags: readonly string[];
}

export interface ToolContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly stepId?: string;
  /** Correlation id for this specific call. */
  readonly callId: string;
  /** Extra context, e.g. permission manager to elevate mid-tool. */
  readonly services?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

/** Base contract every tool implements. */
export interface Tool<Args = Record<string, unknown>, Out = unknown> {
  readonly metadata: ToolInfo;
  validate(args: unknown): asserts args is Args;
  execute(args: Args, ctx: ToolContext): Promise<Out>;
}

export interface ToolExecutionResult<Out = unknown> {
  readonly ok: boolean;
  readonly toolName: string;
  readonly callId: string;
  /** Structured tool output when ok. */
  readonly output?: Out;
  /** Structured error payload when !ok (never raw exceptions). */
  readonly error?: ToolErrorPayload;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface ToolErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Helper for concrete tools: wrap a typed execute fn with shared plumbing. */
export function defineTool<Args, Out>(spec: Tool<Args, Out>): Tool<Args, Out> {
  return spec;
}

/** Snapshot metadata without exposing execute/validate. */
export function toolInfo(tool: Tool): ToolInfo {
  return tool.metadata;
}
