/**
 * FluxAgent — agent state.
 *
 * `AgentState` is the single serializable record of a run: session, goal,
 * messages, plan, observations, tool calls, errors, permissions, memory refs,
 * result, timestamps. `StateManager` mutates it through explicit transitions
 * and emits events.
 */

import { ids } from "../utils/ids.ts";
import type { FluxErrorJSON } from "../utils/errors.ts";
import type { Plan, PlanStep } from "../planning/plan.ts";
import type { ConversationTurn } from "../memory/memory.ts";

// ─── Observation ──────────────────────────────────────────────────────────────

export interface Observation {
  readonly id: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly stepId?: string;
  readonly toolName: string;
  readonly callId: string;
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error: FluxErrorJSON | null;
  readonly durationMs: number;
  readonly at: string;
  /** Free-form observer/verification notes. */
  readonly notes?: string;
}

export function makeObservation(input: {
  sessionId: string;
  runId?: string;
  stepId?: string;
  toolName: string;
  callId: string;
  ok: boolean;
  output?: unknown;
  error?: FluxErrorJSON | null;
  durationMs: number;
  notes?: string;
}): Observation {
  return {
    id: ids.observation(),
    sessionId: input.sessionId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
    toolName: input.toolName,
    callId: input.callId,
    ok: input.ok,
    ...(input.output !== undefined ? { output: input.output } : {}),
    error: input.error ?? null,
    durationMs: input.durationMs,
    at: new Date().toISOString(),
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

export interface ToolCallRecord {
  readonly callId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly at: string;
  readonly stepId?: string;
}

export interface PermissionRecord {
  readonly at: string;
  readonly toolName: string;
  readonly level: string;
  readonly outcome: "granted" | "denied" | "requested";
  readonly reason?: string;
}

export interface AgentState {
  readonly sessionId: string;
  /** Current user goal (latest wins). */
  goal: string;
  /** Serializable conversation (user/agent/system turns). */
  messages: ConversationTurn[];
  /** Current plan snapshot. */
  plan: Plan | null;
  currentStepId: string | null;
  observations: Observation[];
  toolCalls: ToolCallRecord[];
  errors: FluxErrorJSON[];
  permissionLog: PermissionRecord[];
  /** Ids/keys of memory records relevant to this run. */
  memoryRefs: string[];
  finalResult: {
    status: "completed" | "failed" | "cancelled";
    summary: string;
    at: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  /** Monotonic loop counter for the executor. */
  stepCount: number;
}

export function createAgentState(sessionId: string, goal = ""): AgentState {
  const now = new Date().toISOString();
  return {
    sessionId,
    goal,
    messages: [],
    plan: null,
    currentStepId: null,
    observations: [],
    toolCalls: [],
    errors: [],
    permissionLog: [],
    memoryRefs: [],
    finalResult: null,
    createdAt: now,
    updatedAt: now,
    stepCount: 0,
  };
}

/** Plain JSON clone — AgentState must stay JSON-serializable. */
export function serializeState(state: AgentState): string {
  return JSON.stringify(state, null, 2);
}

export function deserializeState(json: string): AgentState {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid AgentState JSON");
  }
  return parsed as AgentState;
}

// ─── StateManager ─────────────────────────────────────────────────────────────

export type StateListener = (state: AgentState) => void;

/**
 * Owns the single AgentState instance for a run. All mutation goes through
 * explicit methods so events and timestamps stay consistent.
 */
export class StateManager {
  private readonly state: AgentState;
  private readonly listeners = new Set<StateListener>();

  constructor(sessionId: string, goal = "") {
    this.state = createAgentState(sessionId, goal);
  }

  get(): Readonly<AgentState> {
    return this.state;
  }

  onChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rebind state from a restored snapshot (checkpoint/resume). */
  replaceWith(next: AgentState): void {
    Object.assign(this.state, next);
    this.touch();
    this.notify();
  }

  private touch(): void {
    (this.state as { updatedAt: string }).updatedAt = new Date().toISOString();
  }

  private notify(): void {
    for (const l of [...this.listeners]) {
      try {
        l(this.state);
      } catch {
        // Listener errors must not corrupt the run.
      }
    }
  }

  setGoal(goal: string): void {
    this.state.goal = goal;
    this.touch();
    this.notify();
  }

  addMessage(turn: ConversationTurn): void {
    this.state.messages.push(turn);
    this.touch();
    this.notify();
  }

  setPlan(plan: Plan): void {
    this.state.plan = plan;
    this.touch();
    this.notify();
  }

  /** In-place mutation of a step inside the current plan. */
  updateStep(stepId: string, mutate: (step: PlanStep) => void): void {
    const plan = this.state.plan;
    if (!plan) return;
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return;
    mutate(step);
    this.touch();
    this.notify();
  }

  setCurrentStep(stepId: string | null): void {
    this.state.currentStepId = stepId;
    this.touch();
    this.notify();
  }

  addObservation(obs: Observation): void {
    this.state.observations.push(obs);
    this.touch();
    this.notify();
  }

  addToolCall(rec: Omit<ToolCallRecord, "at">): void {
    this.state.toolCalls.push({ ...rec, at: new Date().toISOString() });
    this.touch();
    this.notify();
  }

  addError(err: FluxErrorJSON): void {
    this.state.errors.push(err);
    this.touch();
    this.notify();
  }

  addPermissionRecord(rec: Omit<PermissionRecord, "at">): PermissionRecord {
    const full: PermissionRecord = { ...rec, at: new Date().toISOString() };
    this.state.permissionLog.push(full);
    this.touch();
    this.notify();
    return full;
  }

  addMemoryRef(ref: string): void {
    if (!this.state.memoryRefs.includes(ref)) this.state.memoryRefs.push(ref);
    this.touch();
    this.notify();
  }

  setFinalResult(result: NonNullable<AgentState["finalResult"]>): void {
    this.state.finalResult = result;
    this.touch();
    this.notify();
  }

  incrementStepCount(): number {
    this.state.stepCount += 1;
    this.touch();
    return this.state.stepCount;
  }
}
