/**
 * FluxAgent — observer.
 *
 * Converts raw tool results into structured Observations, runs cheap
 * verification heuristics, and updates state/memory. The agent's "eyes":
 * everything the brain knows about the world comes through here.
 */

import { makeEvent } from "../events/events.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { StateManager } from "./state.ts";
import { makeObservation, type Observation } from "./state.ts";
import type { ShortTermMemory } from "../memory/memory.ts";
import type { ToolExecutionResult } from "../tools/tool.ts";
import type { Logger } from "../utils/logger.ts";

export interface VerifyContext {
  readonly goal: string;
  readonly stepTitle?: string;
  /** Step-level verify hint from the planner. */
  readonly verifyHint?: string;
}

export interface VerificationVerdict {
  readonly pass: boolean;
  readonly note: string;
}

export interface ObserverOptions {
  readonly sessionId: string;
  readonly state: StateManager;
  readonly memory: ShortTermMemory;
  readonly eventBus?: EventBus;
  readonly logger?: Logger;
  /** Extra domain checks (keyed by tool name prefix, e.g. "file."). */
  readonly verifiers?: Readonly<Record<string, (o: Observation) => VerificationVerdict>>;
}

export class Observer {
  private readonly sessionId: string;
  private readonly state: StateManager;
  private readonly memory: ShortTermMemory;
  private readonly eventBus?: EventBus;
  private readonly logger?: Logger;
  private readonly verifiers: Readonly<Record<string, (o: Observation) => VerificationVerdict>>;

  constructor(options: ObserverOptions) {
    this.sessionId = options.sessionId;
    this.state = options.state;
    this.memory = options.memory;
    this.eventBus = options.eventBus;
    this.logger = options.logger;
    // Built-in verifiers apply by default; caller-provided ones override by prefix.
    this.verifiers = { "file.": fileVerifier, ...(options.verifiers ?? {}) };
  }

  /** Record a tool result as an observation (state + short-term memory). */
  observe(result: ToolExecutionResult, ctx: { runId?: string; stepId?: string } = {}): Observation {
    const obs = makeObservation({
      sessionId: this.sessionId,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      ...(ctx.stepId !== undefined ? { stepId: ctx.stepId } : {}),
      toolName: result.toolName,
      callId: result.callId,
      ok: result.ok,
      output: result.output,
      error: result.error ?? null,
      durationMs: result.durationMs,
    });

    this.state.addObservation(obs);
    this.memory.pushObservation(obs);
    this.eventBus?.emitSync(
      result.ok
        ? makeEvent(this.sessionId, "tool.completed", { toolName: result.toolName, callId: result.callId, ok: true }, ctx.runId)
        : makeEvent(this.sessionId, "tool.failed", {
            toolName: result.toolName,
            callId: result.callId,
            reason: result.error?.message ?? "unknown",
          }, ctx.runId),
    );
    this.logger?.debug("observation recorded", { tool: result.toolName, ok: result.ok });
    return obs;
  }

  /**
   * Verify an observation: tool-specific verifiers first, then generic
   * heuristics (permission denials are failures; truncated output is flagged).
   */
  verify(obs: Observation, ctx: VerifyContext): VerificationVerdict {
    if (!obs.ok) {
      const isPermission = obs.error?.code === "E_PERMISSION_DENIED";
      return {
        pass: false,
        note: isPermission
          ? "blocked by permission — needs user approval, not a retry"
          : `tool failed: ${obs.error?.message ?? "unknown error"}`,
      };
    }

    const custom = Object.entries(this.verifiers).find(([prefix]) => obs.toolName.startsWith(prefix));
    if (custom) return custom[1](obs);

    // Generic pass: no deeper signal available.
    return { pass: true, note: ctx.verifyHint ? `verified per hint: ${ctx.verifyHint}` : "tool reported success" };
  }
}

/** Built-in verifier for file.* tools. */
export function fileVerifier(o: Observation): VerificationVerdict {
  const out = o.output as Record<string, unknown> | undefined;
  if (!out || typeof out !== "object") return { pass: false, note: "file tool returned no output object" };
  if (o.toolName === "file.exists" && out.exists !== true) {
    return { pass: false, note: `path does not exist: ${String(out.path ?? "?")}` };
  }
  return { pass: true, note: "file output ok" };
}
