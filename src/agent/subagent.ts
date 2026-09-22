/**
 * FluxAgent — subagents.
 *
 * Controlled delegation: the parent spawns a child agent with an isolated
 * task, a scoped tool subset, its own permission boundary, a timeout, and a
 * structured result contract. Subagents cannot escalate their own permissions
 * and cannot outlive their cancellation/timeout.
 */

import { performance } from "node:perf_hooks";

import type { Agent, AgentRunResult } from "./agent.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { PermissionManager } from "../security/permission-manager.ts";
import type { EventBus } from "../events/event-bus.ts";
import { makeEvent } from "../events/events.ts";
import type { Logger } from "../utils/logger.ts";
import { FluxError } from "../utils/errors.ts";
import type { PermissionLevel } from "../tools/permissions.ts";

export type SubagentKind = "research" | "coding" | "analysis" | "verification" | "general";

export interface SubagentSpec {
  readonly kind: SubagentKind;
  readonly task: string;
  /** Tool names the child may use; everything else is invisible. */
  readonly allowedTools: readonly string[];
  /** Permission ceiling for the child (≤ parent ceiling; enforced). */
  readonly permissionCeiling: PermissionLevel;
  readonly timeoutMs?: number;
  /** Inputs passed through to the child's context. */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export type SubagentLifecycle =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

export interface SubagentResult {
  readonly spec: SubagentSpec;
  readonly lifecycle: SubagentLifecycle;
  readonly summary: string;
  readonly durationMs: number;
  readonly run?: AgentRunResult;
  readonly error?: { code: string; message: string };
}

export interface SubagentHandle {
  readonly id: string;
  readonly spec: SubagentSpec;
  readonly promise: Promise<SubagentResult>;
  cancel(reason?: string): void;
}

export interface SubagentHostDeps {
  /** Factory that builds a fresh Agent for the child run. */
  readonly createAgent: (options: { toolNames: readonly string[]; ceiling: PermissionLevel }) => Agent;
  readonly eventBus?: EventBus;
  readonly logger?: Logger;
  /** Parent ceiling for validating the child's requested ceiling. */
  readonly parentCeiling: PermissionLevel;
}

const PERM_ORDER: readonly PermissionLevel[] = ["READ_ONLY", "SAFE_WRITE", "USER_CONFIRMATION", "PRIVILEGED"];

export class SubagentManager {
  private readonly deps: SubagentHostDeps;
  private readonly running = new Map<string, { handle: SubagentHandle; abort: AbortController }>();

  constructor(deps: SubagentHostDeps) {
    this.deps = deps;
  }

  /** Spawn a subagent. Returns a handle; the promise settles with a structured result. */
  spawn(spec: SubagentSpec): SubagentHandle {
    const id = `sub_${Math.random().toString(36).slice(2, 12)}`;
    const abort = new AbortController();
    const started = performance.now();

    // Clamp requested ceiling to the parent's — children never escalate.
    const ceiling = PERM_ORDER.indexOf(spec.permissionCeiling) <= PERM_ORDER.indexOf(this.deps.parentCeiling)
      ? spec.permissionCeiling
      : this.deps.parentCeiling;
    const effectiveSpec: SubagentSpec = { ...spec, permissionCeiling: ceiling };

    this.deps.eventBus?.emitSync(
      makeEvent("subagent", "session.started", { goal: `[${spec.kind}] ${spec.task}` }),
    );

    const promise = (async (): Promise<SubagentResult> => {
      try {
        const agent = this.deps.createAgent({
          toolNames: effectiveSpec.allowedTools,
          ceiling: effectiveSpec.permissionCeiling,
        });

        const timeoutMs = effectiveSpec.timeoutMs ?? 120_000;
        const timer = setTimeout(() => abort.abort(new FluxError({ code: "E_STEP_TIMEOUT", message: `subagent timeout after ${timeoutMs}ms` })), timeoutMs);

        try {
          const run = await agent.run(effectiveSpec.task, { signal: abort.signal });
          const lifecycle: SubagentLifecycle = run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : "failed";
          return {
            spec: effectiveSpec,
            lifecycle,
            summary: run.summary,
            durationMs: performance.now() - started,
            run,
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        const isTimeout = e instanceof FluxError && e.code === "E_STEP_TIMEOUT";
        return {
          spec: effectiveSpec,
          lifecycle: isTimeout ? "timeout" : "failed",
          summary: isTimeout ? `subagent timed out: ${effectiveSpec.task}` : `subagent failed: ${e instanceof Error ? e.message : String(e)}`,
          durationMs: performance.now() - started,
          error: {
            code: isTimeout ? "E_STEP_TIMEOUT" : "E_INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          },
        };
      } finally {
        this.running.delete(id);
      }
    })();

    const handle: SubagentHandle = {
      id,
      spec: effectiveSpec,
      promise,
      cancel: (reason = "cancelled by parent") => {
        abort.abort(new FluxError({ code: "E_CANCELLED", message: reason }));
      },
    };
    this.running.set(id, { handle, abort });
    return handle;
  }

  /** Spawn and await in one call. */
  async run(spec: SubagentSpec): Promise<SubagentResult> {
    const handle = this.spawn(spec);
    return handle.promise;
  }

  /** Cancel all running subagents (session teardown / parent abort). */
  cancelAll(reason = "parent shutting down"): void {
    for (const { handle } of this.running.values()) {
      handle.cancel(reason);
    }
  }

  get activeCount(): number {
    return this.running.size;
  }
}

// Re-export for consumers building spec files.
export type { AgentRunResult };
export { FluxError as SubagentFluxError };
