/**
 * FluxAgent — executor.
 *
 * Runs plan steps: SELECT NEXT ACTION → CHECK PERMISSION → EXECUTE TOOL →
 * OBSERVE → VERIFY → RECOVER. The executor orchestrates; it never contains
 * tool logic itself.
 */

import { sleep } from "../utils/validation.ts";
import { makeEvent } from "../events/events.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { Plan, PlanStep } from "../planning/plan.ts";
import { dependenciesSatisfied, anyDependencyFailed } from "../planning/plan.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { PermissionManager } from "../security/permission-manager.ts";
import type { Observer } from "./observer.ts";
import type { RecoveryManager } from "./recovery.ts";
import type { StateManager } from "./state.ts";
import type { Logger } from "../utils/logger.ts";
import { CancelledError } from "../utils/errors.ts";
import { ids } from "../utils/ids.ts";

export interface ExecutorOptions {
  readonly sessionId: string;
  readonly registry: ToolRegistry;
  readonly permissions: PermissionManager;
  readonly observer: Observer;
  readonly recovery: RecoveryManager;
  readonly state: StateManager;
  readonly eventBus?: EventBus;
  readonly logger?: Logger;
  readonly stepTimeoutMs?: number;
}

export interface StepOutcome {
  readonly stepId: string;
  readonly status: "completed" | "failed" | "skipped" | "cancelled";
  readonly summary: string;
}

export class Executor {
  private readonly opts: ExecutorOptions;
  private replansUsed = 0;

  constructor(options: ExecutorOptions) {
    this.opts = options;
  }

  /**
   * Execute pending steps of the plan. Returns when the plan is complete,
   * a step aborts the run, or the run is cancelled.
   */
  async executePlan(plan: Plan, ctx: { runId?: string; goal: string; maxSteps: number; signal?: AbortSignal }): Promise<{
    status: "completed" | "failed" | "cancelled";
    lastOutcome: StepOutcome | null;
  }> {
    let lastOutcome: StepOutcome | null = null;

    while (true) {
      if (ctx.signal?.aborted) {
        return { status: "cancelled", lastOutcome };
      }
      if (this.opts.state.get().stepCount >= ctx.maxSteps) {
        return { status: "failed", lastOutcome };
      }

      const next = this.nextRunnableStep(plan);
      if (!next) {
        const allTerminal = plan.steps.every(
          (s) => s.status === "completed" || s.status === "skipped" || s.status === "failed",
        );
        const status = allTerminal && plan.steps.some((s) => s.status === "completed")
          ? "completed"
          : "failed";
        return { status, lastOutcome };
      }

      lastOutcome = await this.runStep(next, ctx);

      if (lastOutcome.status === "failed") return { status: "failed", lastOutcome };
      if (lastOutcome.status === "cancelled") return { status: "cancelled", lastOutcome };
    }
  }

  /** Pick the next pending step whose deps are satisfied. */
  private nextRunnableStep(plan: Plan): PlanStep | undefined {
    return plan.steps.find(
      (s) => s.status === "pending" && dependenciesSatisfied(s, plan.steps),
    );
  }

  /** Current plan id from state (used for events). */
  private currentPlanId(): string {
    return this.opts.state.get().plan?.id ?? "unknown";
  }

  private async runStep(step: PlanStep, ctx: { runId?: string; goal: string; signal?: AbortSignal }): Promise<StepOutcome> {
    const { state, eventBus, sessionId } = this.opts;
    state.setCurrentStep(step.id);
    state.incrementStepCount();
    state.updateStep(step.id, (s) => {
      s.status = "running";
    });
    eventBus?.emitSync(
      makeEvent(sessionId, "step.started", { planId: this.currentPlanId(), stepId: step.id, description: step.title }, ctx.runId),
    );

    // Pure-reasoning step (no tool): auto-pass with a note.
    if (!step.tool) {
      state.updateStep(step.id, (s) => {
        s.status = "completed";
        s.result = { summary: "reasoning step completed", observationId: undefined };
      });
      eventBus?.emitSync(makeEvent(sessionId, "step.completed", { planId: this.currentPlanId(), stepId: step.id, summary: "reasoning step" }, ctx.runId));
      return { stepId: step.id, status: "completed", summary: "reasoning step completed" };
    }

    const tool = this.opts.registry.get(step.tool);
    if (!tool) {
      state.updateStep(step.id, (s) => {
        s.status = "failed";
        s.error = { name: "FluxError", code: "E_TOOL_NOT_FOUND", message: `tool ${step.tool} not registered`, details: {} };
      });
      return { stepId: step.id, status: "failed", summary: `tool ${step.tool} not registered` };
    }

    // CHECK PERMISSION
    const args = (step.args ?? {}) as Record<string, unknown>;
    const allowed = await this.opts.permissions.authorize({
      tool: tool.metadata,
      args,
      runId: ctx.runId,
    });
    this.opts.state.addPermissionRecord({
      toolName: tool.metadata.name,
      level: tool.metadata.permissionLevel,
      outcome: allowed ? "granted" : "denied",
    });
    if (!allowed) {
      state.updateStep(step.id, (s) => {
        s.status = "blocked";
      });
      return {
        stepId: step.id,
        status: "failed",
        summary: `permission denied for ${tool.metadata.name}`,
      };
    }

    // EXECUTE TOOL (+ retries via recovery)
    let attempt = 0;
    void attempt;
    while (true) {
      const callId = ids.toolCall();
      eventBus?.emitSync(
        makeEvent(sessionId, "tool.called", { toolName: tool.metadata.name, callId, args }, ctx.runId),
      );
      const result = await this.opts.registry.execute({
        toolName: tool.metadata.name,
        args,
        ctx: { runId: ctx.runId, stepId: step.id, signal: ctx.signal },
      });
      eventBus?.emitSync(
        result.ok
          ? makeEvent(sessionId, "tool.completed", { toolName: tool.metadata.name, callId, ok: true }, ctx.runId)
          : makeEvent(sessionId, "tool.failed", { toolName: tool.metadata.name, callId, reason: result.error?.message ?? "unknown" }, ctx.runId),
      );
      const obs = this.opts.observer.observe(result, { runId: ctx.runId, stepId: step.id });

      if (result.ok) {
        const verdict = this.opts.observer.verify(obs, { goal: ctx.goal, stepTitle: step.title, verifyHint: step.verify });
        if (verdict.pass) {
          state.updateStep(step.id, (s) => {
            s.status = "completed";
            s.result = { summary: verdict.note, observationId: obs.id };
          });
          eventBus?.emitSync(
            makeEvent(sessionId, "step.completed", { planId: this.currentPlanId(), stepId: step.id, summary: verdict.note }, ctx.runId),
          );
          return { stepId: step.id, status: "completed", summary: verdict.note };
        }
        // Verification failed → treat as failure with the verdict note.
        state.addError({ name: "VerificationError", code: "E_VALIDATION", message: verdict.note, details: {} });
      }

      // RECOVER IF NECESSARY
      const decision = this.opts.recovery.decide({
        step,
        observation: obs,
        replansSoFar: this.replansUsed,
        goal: ctx.goal,
      });
      await this.opts.recovery.apply(decision, { sessionId, runId: ctx.runId, stepId: step.id });

      if (decision.action === "retry") {
        attempt += 1;
        state.updateStep(step.id, (s) => {
          s.retryCount += 1;
        });
        if (decision.retryDelayMs && decision.retryDelayMs > 0) {
          await sleep(decision.retryDelayMs, ctx.signal).catch(() => {
            throw new CancelledError("retry backoff");
          });
        }
        continue; // retry loop
      }

      if (decision.action === "replan") {
        this.replansUsed += 1;
        // Mark step failed; the agent loop (agent.ts) decides replanning.
        state.updateStep(step.id, (s) => {
          s.status = "failed";
          s.error = obs.error ?? { name: "FluxError", code: "E_INTERNAL", message: "replan required", details: {} };
        });
        eventBus?.emitSync(
          makeEvent(sessionId, "step.failed", { planId: this.currentPlanId(), stepId: step.id, reason: decision.reason }, ctx.runId),
        );
        return { stepId: step.id, status: "failed", summary: decision.reason };
      }

      // abort
      state.updateStep(step.id, (s) => {
        s.status = "failed";
        s.error = obs.error ?? { name: "FluxError", code: "E_INTERNAL", message: decision.reason, details: {} };
      });
      eventBus?.emitSync(
        makeEvent(sessionId, "step.failed", { planId: this.currentPlanId(), stepId: step.id, reason: decision.reason }, ctx.runId),
      );
      return { stepId: step.id, status: "cancelled", summary: decision.reason };
    }
  }
}
