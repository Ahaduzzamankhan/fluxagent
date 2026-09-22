/**
 * FluxAgent — the agent brain.
 *
 * Orchestrates: UNDERSTAND → CREATE PLAN → EXECUTE (via Executor) →
 * VERIFY → RECOVER (replan when possible) → FINISH. Dependencies are
 * injected; the Agent holds no hidden global state.
 */

import { ids } from "../utils/ids.ts";
import { toFluxError } from "../utils/errors.ts";
import { makeEvent } from "../events/events.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { PermissionManager } from "../security/permission-manager.ts";
import type { StateManager } from "./state.ts";
import type { RunContext } from "./context.ts";
import type { ReasoningEngine } from "./reasoning.ts";
import type { Planner } from "./planner.ts";
import type { Executor } from "./executor.ts";
import type { Observer } from "./observer.ts";
import type { RecoveryManager } from "./recovery.ts";
import type { Logger } from "../utils/logger.ts";
import type { MemoryManager } from "../memory/memory.ts";

export interface AgentOptions {
  readonly sessionId: string;
  readonly provider: LlmProvider;
  readonly registry: ToolRegistry;
  readonly permissions: PermissionManager;
  readonly state: StateManager;
  readonly context: RunContext;
  readonly reasoning: ReasoningEngine;
  readonly planner: Planner;
  readonly executor: Executor;
  readonly observer: Observer;
  readonly recovery: RecoveryManager;
  readonly eventBus: EventBus;
  readonly memory: MemoryManager;
  readonly logger?: Logger;
  readonly maxSteps?: number;
  readonly maxReplans?: number;
}

export interface AgentRunResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly summary: string;
  readonly planId: string | null;
  readonly stepsCompleted: number;
  readonly stepsFailed: number;
  readonly observations: number;
  readonly durationMs: number;
}

export class Agent {
  private readonly opts: AgentOptions;

  constructor(options: AgentOptions) {
    this.opts = options;
  }

  get sessionId(): string {
    return this.opts.sessionId;
  }

  /** Run a goal end-to-end. */
  async run(goal: string, options: { signal?: AbortSignal } = {}): Promise<AgentRunResult> {
    const { state, eventBus, logger } = this.opts;
    const runId = ids.run();
    const startedAt = Date.now();
    state.setGoal(goal);
    state.addMessage({ role: "user", content: goal, at: new Date().toISOString() });
    this.opts.memory.shortTerm.pushMessage({ role: "user", content: goal, at: new Date().toISOString() });

    eventBus.emitSync(makeEvent(state.get().sessionId, "agent.started", { goal }, runId));

    let replans = 0;
    const maxReplans = this.opts.maxReplans ?? 2;

    try {
      // UNDERSTAND + CREATE PLAN
      eventBus.emitSync(makeEvent(state.get().sessionId, "agent.thinking", { note: "creating plan" }, runId));
      const proposed = await this.opts.reasoning.createPlan(goal, options.signal);
      const plan = this.opts.planner.buildPlan(goal, proposed);
      state.setPlan(plan);
      this.opts.memory.shortTerm.setCurrentPlanRef(plan.id);
      eventBus.emitSync(
        makeEvent(state.get().sessionId, "plan.created", { planId: plan.id, stepCount: plan.steps.length }, runId),
      );

      // EXECUTE + RECOVER loop
      const execResult = await this.opts.executor.executePlan(plan, {
        runId,
        goal,
        maxSteps: this.opts.maxSteps ?? 60,
        signal: options.signal,
      });

      // If the executor stopped because a step needs replanning, try again.
      while (execResult.status === "failed" && replans < maxReplans && !options.signal?.aborted) {
        const failedStep = plan.steps.find((s) => s.status === "failed");
        if (!failedStep) break;
        replans += 1;
        eventBus.emitSync(
          makeEvent(state.get().sessionId, "agent.thinking", { note: `replanning (${replans}/${maxReplans})` }, runId),
        );
        const hints = [`step "${failedStep.title}" failed: ${failedStep.error?.message ?? "unknown"}`];
        const revised = await this.attemptReplan(goal, plan, hints, options.signal);
        if (!revised) break;
        state.setPlan(revised);
        eventBus.emitSync(
          makeEvent(state.get().sessionId, "plan.updated", { planId: revised.id, note: `replan ${replans}` }, runId),
        );
        const retry = await this.opts.executor.executePlan(revised, {
          runId,
          goal,
          maxSteps: this.opts.maxSteps ?? 60,
          signal: options.signal,
        });
        Object.assign(execResult, retry);
      }

      // VERIFY + FINISH
      const s = state.get();
      const stepsCompleted = s.plan?.steps.filter((st) => st.status === "completed").length ?? 0;
      const stepsFailed = s.plan?.steps.filter((st) => st.status === "failed").length ?? 0;
      const summary =
        execResult.status === "completed"
          ? `goal achieved: ${goal} (${stepsCompleted} steps completed)`
          : `run ended with status ${execResult.status}: ${execResult.lastOutcome?.summary ?? "unknown reason"}`;

      state.setFinalResult({
        status: execResult.status,
        summary,
        at: new Date().toISOString(),
      });
      state.addMessage({ role: "agent", content: summary, at: new Date().toISOString() });
      this.opts.memory.shortTerm.pushMessage({ role: "agent", content: summary, at: new Date().toISOString() });

      eventBus.emitSync(
        execResult.status === "completed"
          ? makeEvent(state.get().sessionId, "agent.completed", { summary }, runId)
          : makeEvent(state.get().sessionId, "agent.failed", { reason: summary }, runId),
      );

      // Long-term memory: record the outcome.
      await this.opts.memory.longTerm.recordTaskOutcome({
        goal,
        success: execResult.status === "completed",
        summary,
        stepsTaken: s.stepCount,
      });

      return {
        status: execResult.status,
        summary,
        planId: s.plan?.id ?? null,
        stepsCompleted,
        stepsFailed,
        observations: s.observations.length,
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      const flux = toFluxError(e);
      state.addError(flux.toJSON());
      const reason = `agent failed: ${flux.message}`;
      state.setFinalResult({ status: "failed", summary: reason, at: new Date().toISOString() });
      eventBus.emitSync(makeEvent(state.get().sessionId, "agent.failed", { reason }, runId));
      logger?.error("agent run failed", { code: flux.code, message: flux.message });
      return {
        status: "failed",
        summary: reason,
        planId: state.get().plan?.id ?? null,
        stepsCompleted: 0,
        stepsFailed: 0,
        observations: state.get().observations.length,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  private async attemptReplan(
    goal: string,
    currentPlan: import("../planning/plan.ts").Plan,
    hints: readonly string[],
    signal?: AbortSignal,
  ): Promise<import("../planning/plan.ts").Plan | null> {
    try {
      const proposed = await this.opts.reasoning.createPlan(
        `${goal}\n\nPrevious attempt failed. Failure context: ${hints.join("; ")}`,
        signal,
      );
      return this.opts.planner.revise(currentPlan, proposed.steps, hints[0] ?? "recovery");
    } catch (e) {
      this.opts.logger?.warn("replan failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }
}


