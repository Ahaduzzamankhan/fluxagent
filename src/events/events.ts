/**
 * FluxAgent — event definitions.
 *
 * A single discriminated union of runtime events. Every event carries `type`,
 * `id`, `timestamp`, and `sessionId`. Events are pure data — safe to serialize
 * and forward to a UI later.
 */

import { ids } from "../utils/ids.ts";

export type AgentEventType =
  // lifecycle
  | "agent.started"
  | "agent.thinking"
  | "agent.decided"
  | "agent.verified"
  | "agent.recovered"
  | "agent.completed"
  | "agent.failed"
  | "agent.cancelled"
  // planning
  | "plan.created"
  | "plan.updated"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "step.skipped"
  // tools
  | "tool.called"
  | "tool.completed"
  | "tool.failed"
  // permissions
  | "permission.requested"
  | "permission.granted"
  | "permission.denied"
  // memory
  | "memory.updated"
  // python bridge
  | "python.requested"
  | "python.completed"
  | "python.failed"
  // runtime
  | "session.started"
  | "session.ended"
  | "checkpoint.saved"
  | "checkpoint.restored"
  // logging passthrough
  | "log.record";

export interface AgentEventBase {
  readonly id: string;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly runId?: string;
}

export type AgentEvent = AgentEventBase &
  (
    | { readonly type: "agent.started"; readonly goal: string }
    | { readonly type: "agent.thinking"; readonly note: string }
    | { readonly type: "agent.decided"; readonly note: string; readonly stepId?: string }
    | { readonly type: "agent.verified"; readonly note: string }
    | { readonly type: "agent.recovered"; readonly stepId?: string; readonly strategy: string }
    | { readonly type: "agent.completed"; readonly summary: string }
    | { type: "agent.failed"; readonly reason: string }
    | { type: "agent.cancelled"; readonly reason: string }
    | { readonly type: "plan.created"; readonly planId: string; readonly stepCount: number }
    | { type: "plan.updated"; readonly planId: string; readonly note: string }
    | { readonly type: "step.started"; readonly planId: string; readonly stepId: string; readonly description: string }
    | { readonly type: "step.completed"; readonly planId: string; readonly stepId: string; readonly summary: string }
    | { readonly type: "step.failed"; readonly planId: string; readonly stepId: string; readonly reason: string }
    | { readonly type: "step.skipped"; readonly planId: string; readonly stepId: string; readonly reason: string }
    | { readonly type: "tool.called"; readonly toolName: string; readonly callId: string; readonly args: unknown }
    | { readonly type: "tool.completed"; readonly toolName: string; readonly callId: string; readonly ok: boolean }
    | { readonly type: "tool.failed"; readonly toolName: string; readonly callId: string; readonly reason: string }
    | { readonly type: "permission.requested"; readonly toolName: string; readonly level: string; readonly reason?: string }
    | { readonly type: "permission.granted"; readonly toolName: string; readonly level: string }
    | { readonly type: "permission.denied"; readonly toolName: string; readonly level: string; readonly reason: string }
    | { readonly type: "memory.updated"; readonly store: string; readonly key?: string }
    | { readonly type: "python.requested"; readonly module: string; readonly function: string }
    | { readonly type: "python.completed"; readonly module: string; readonly durationMs: number }
    | { readonly type: "python.failed"; readonly module: string; readonly reason: string }
    | { readonly type: "session.started"; readonly goal?: string }
    | { readonly type: "session.ended"; readonly reason: string }
    | { readonly type: "checkpoint.saved"; readonly label: string; readonly path?: string }
    | { readonly type: "checkpoint.restored"; readonly label: string }
    | { readonly type: "log.record"; readonly record: unknown }
  );

export function makeEvent<T extends AgentEvent["type"]>(
  sessionId: string,
  type: T,
  payload: Omit<Extract<AgentEvent, { type: T }>, keyof AgentEventBase | "type">,
  runId?: string,
): Extract<AgentEvent, { type: T }> {
  const base = { id: ids.event(), timestamp: new Date().toISOString(), sessionId, ...(runId ? { runId } : {}) };
  return { ...base, type, ...payload } as Extract<AgentEvent, { type: T }>;
}
