/**
 * FluxAgent — traceability.
 *
 * Structured lifecycle events + a TraceRecorder that stitches
 * task → plan → decision → tool → observation → verification → recovery
 * into causal chains, so "why did the agent do this?" is answerable from
 * structured data rather than raw logs.
 *
 * `attachEventBus` bridges a session EventBus into the recorder: every
 * agent-lifecycle event becomes a trace record tagged with the session id,
 * so diagnostics work without any extra instrumentation at call sites.
 */

import type { AgentEventType, AgentEvent } from "../events/events.ts";

// ─── Extended lifecycle event types (emitted via the same bus) ────────────────

export type TraceEventType =
  | "task.created"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "plan.created"
  | "plan.updated"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "decision.created"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "observation.created"
  | "verification.started"
  | "verification.completed"
  | "recovery.started"
  | "checkpoint.created"
  | "checkpoint.restored"
  | "memory.created"
  | "memory.retrieved";

export const TRACE_EVENT_TYPES: readonly TraceEventType[] = [
  "task.created", "task.started", "task.completed", "task.failed",
  "plan.created", "plan.updated", "step.started", "step.completed", "step.failed",
  "agent.started", "agent.completed", "agent.failed",
  "decision.created", "tool.started", "tool.completed", "tool.failed",
  "observation.created", "verification.started", "verification.completed",
  "recovery.started", "checkpoint.created", "checkpoint.restored",
  "memory.created", "memory.retrieved",
];

export interface TraceRecord {
  readonly id: string;
  readonly at: string;
  readonly type: TraceEventType;
  readonly taskId?: string;
  readonly planId?: string;
  readonly stepId?: string;
  readonly decisionId?: string;
  readonly callId?: string;
  readonly observationId?: string;
  readonly detail: Readonly<Record<string, unknown>>;
  /** Parent record id — chains records into a causal tree. */
  readonly parentTraceId?: string;
}

// ─── TraceRecorder ────────────────────────────────────────────────────────────

export interface TraceRecorderOptions {
  readonly maxRecords?: number;
  readonly onRecord?: (record: TraceRecord) => void;
}

export class TraceRecorder {
  private readonly records: TraceRecord[] = [];
  private readonly maxRecords: number;
  private readonly onRecord?: (record: TraceRecord) => void;
  private seq = 0;

  constructor(options: TraceRecorderOptions = {}) {
    this.maxRecords = options.maxRecords ?? 2000;
    this.onRecord = options.onRecord;
  }

  /** Record a lifecycle event with causal linkage. */
  record(input: {
    type: TraceEventType;
    taskId?: string;
    planId?: string;
    stepId?: string;
    decisionId?: string;
    callId?: string;
    observationId?: string;
    parentTraceId?: string;
    detail?: Record<string, unknown>;
  }): TraceRecord {
    const rec: TraceRecord = {
      id: `trace_${++this.seq}`,
      at: new Date().toISOString(),
      type: input.type,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.planId !== undefined ? { planId: input.planId } : {}),
      ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
      ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
      ...(input.callId !== undefined ? { callId: input.callId } : {}),
      ...(input.observationId !== undefined ? { observationId: input.observationId } : {}),
      ...(input.parentTraceId !== undefined ? { parentTraceId: input.parentTraceId } : {}),
      detail: input.detail ?? {},
    };
    this.records.push(rec);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    this.onRecord?.(rec);
    return rec;
  }

  /** Full causal chain for a step: decision → tool → observation → verification → recovery. */
  chainForStep(stepId: string): readonly TraceRecord[] {
    const direct = this.records.filter((r) => r.stepId === stepId);
    const ids = new Set(direct.map((r) => r.id));
    // Pull in parents/children by linkage.
    for (const r of direct) {
      if (r.parentTraceId) {
        const parent = this.records.find((x) => x.id === r.parentTraceId);
        if (parent) ids.add(parent.id);
      }
    }
    return this.records.filter((r) => ids.has(r.id));
  }

  /** Everything for a task (or session) in chronological order. */
  forTask(taskId: string): readonly TraceRecord[] {
    return this.records.filter(
      (r) => r.taskId === taskId || r.detail["taskId"] === taskId || r.detail["sessionId"] === taskId,
    );
  }

  all(): readonly TraceRecord[] {
    return [...this.records];
  }

  get size(): number {
    return this.records.length;
  }
}

// ─── Bus bridge ───────────────────────────────────────────────────────────────

/** AgentEvent types that map to trace records (bridge target set). */
const BUS_TRACE_MAP: Partial<Record<AgentEventType, TraceEventType>> = {
  "agent.started": "agent.started",
  "agent.completed": "agent.completed",
  "agent.failed": "agent.failed",
  "plan.created": "plan.created",
  "plan.updated": "plan.updated",
  "step.started": "step.started",
  "step.completed": "step.completed",
  "step.failed": "step.failed",
  "tool.called": "tool.started",
  "tool.completed": "tool.completed",
  "tool.failed": "tool.failed",
  "agent.recovered": "recovery.started",
  "checkpoint.saved": "checkpoint.created",
  "checkpoint.restored": "checkpoint.restored",
  "memory.updated": "memory.created",
};

interface BusLike {
  any(handler: (event: AgentEvent) => void | boolean | Promise<void | boolean>): () => void;
}

/**
 * Attach a TraceRecorder to an EventBus: every mappable event becomes a
 * trace record with { sessionId, subject } detail. Returns a detach fn.
 */
export function attachEventBus(trace: TraceRecorder, bus: BusLike): () => void {
  return bus.any((event) => {
    const type = BUS_TRACE_MAP[event.type as AgentEventType];
    if (!type) return;
    const detail: Record<string, unknown> = { sessionId: event.sessionId };
    const e = event as AgentEvent & Record<string, unknown>;
    // Copy a few well-known identifiers into detail for queryability.
    for (const key of ["goal", "planId", "stepId", "toolName", "callId", "summary", "reason", "note", "description", "strategy"]) {
      if (typeof e[key] === "string") detail[key] = e[key];
    }
    trace.record({
      type,
      ...(typeof e.planId === "string" ? { planId: e.planId } : {}),
      ...(typeof e.stepId === "string" ? { stepId: e.stepId } : {}),
      ...(typeof e.callId === "string" ? { callId: e.callId } : {}),
      detail,
    });
  });
}

/** Map a runtime event type to a trace type where 1:1 (used by bridges). */
export function traceTypeFor(eventType: AgentEventType): TraceEventType | undefined {
  return BUS_TRACE_MAP[eventType];
}
