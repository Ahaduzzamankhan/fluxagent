/**
 * FluxAgent — ToolRegistry.
 *
 * Single source of truth for tools. The agent requests capabilities only by
 * registered name; `execute()` is the ONLY path to tool code, and it routes
 * through validation → permission check → execution → structured result.
 */

import { ids } from "../utils/ids.ts";
import { Logger } from "../utils/logger.ts";
import {
  ToolNotFoundError,
  ToolArgumentsInvalidError,
  toFluxError,
} from "../utils/errors.ts";
import type { PermissionLevel } from "./permissions.ts";
import type {
  Tool,
  ToolContext,
  ToolExecutionResult,
  ToolInfo,
} from "./tool.ts";

export type { ToolInfo };
export type ToolInfoLite = ToolInfo;

export interface RegistryOptions {
  readonly logger?: Logger;
  readonly sessionId: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly logger?: Logger;
  private readonly sessionId: string;

  constructor(options: RegistryOptions) {
    this.logger = options.logger;
    this.sessionId = options.sessionId;
  }

  register(tool: Tool): () => void {
    const name = tool.metadata.name;
    if (this.tools.has(name)) {
      throw new Error(`Tool already registered: "${name}"`);
    }
    this.tools.set(name, tool);
    this.logger?.debug("tool registered", { tool: name, permission: tool.metadata.permissionLevel });
    return () => this.tools.delete(name);
  }

  registerAll(tools: readonly Tool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Serializable tool descriptors (for LLM prompts / UI). */
  list(): ToolInfo[] {
    return [...this.tools.values()]
      .map((t) => t.metadata)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Build the ToolContext for a call. */
  context(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: this.sessionId,
      callId: ids.toolCall(),
      ...overrides,
    };
  }

  /**
   * The single execution path: validate → permission check → execute →
   * structured result. Permission checking is delegated to a callback so
   * security stays orthogonal to the registry.
   */
  async execute(options: {
    toolName: string;
    args: unknown;
    ctx?: Partial<ToolContext>;
    /** Return true to allow; receives tool metadata for the decision. */
    checkPermission?: (info: ToolInfo) => Promise<boolean>;
  }): Promise<ToolExecutionResult> {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const callId = options.ctx?.callId ?? ids.toolCall();

    const tool = this.get(options.toolName);
    if (!tool) {
      throw new ToolNotFoundError(options.toolName, this.names());
    }

    // 1) Validation (tool's own asserts, backed by its schema).
    try {
      tool.validate(options.args);
    } catch (err) {
      const issues = err instanceof Error ? [err.message] : [String(err)];
      throw new ToolArgumentsInvalidError(options.toolName, issues);
    }

    // 2) Permission gate (denial is a structured result, not a throw).
    if (options.checkPermission) {
      const allowed = await options.checkPermission(tool.metadata);
      if (!allowed) {
        return {
          ok: false,
          toolName: options.toolName,
          callId,
          error: {
            code: "E_PERMISSION_DENIED",
            message: `Permission denied for tool "${options.toolName}" (level ${tool.metadata.permissionLevel})`,
          },
          durationMs: performance.now() - t0,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }
    }

    // 3) Execution — never let raw exceptions escape.
    const ctx: ToolContext = this.context({ ...options.ctx, callId });
    try {
      const output = await tool.execute(options.args as Record<string, unknown>, ctx);
      return {
        ok: true,
        toolName: options.toolName,
        callId,
        output,
        durationMs: performance.now() - t0,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (e) {
      const flux = toFluxError(e);
      return {
        ok: false,
        toolName: options.toolName,
        callId,
        error: flux.toJSON(),
        durationMs: performance.now() - t0,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }
}
