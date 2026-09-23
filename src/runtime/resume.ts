/**
 * FluxAgent — session resume service (Phase 7).
 *
 * Builds on CheckpointManager to make pause/resume a first-class operation:
 *
 *   pause  → checkpoint + explicit pause marker
 *   resume → strict validation (version, shape, session match) → restore
 *
 * Resume is FAIL-CLOSED:
 *   - corrupted checkpoints (bad JSON, missing fields) are rejected with a
 *     structured error, never partially restored;
 *   - incompatible versions are rejected (no silent upgrades);
 *   - expired grants from the original session are NOT restored — permission
 *     grants always re-ask after a resume.
 */

import type { Checkpoint, CheckpointStore, CheckpointManager } from "./checkpoint.ts";
import { CHECKPOINT_VERSION } from "./checkpoint.ts";
import type { AgentState } from "../agent/state.ts";
import { FluxError } from "../utils/errors.ts";
import { ids } from "../utils/ids.ts";
import { makeEvent } from "../events/events.ts";
import type { EventBus } from "../events/event-bus.ts";

export type PauseReason = "user" | "approval-waiting" | "crash-recovery" | "resource-limit";

export interface PauseRecord {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly reason: PauseReason;
  readonly at: string;
  /** Human-readable note (e.g. "waiting for USER_CONFIRMATION approval"). */
  readonly note?: string;
}

export interface ResumeValidation {
  ok: boolean;
  problems: string[];
  checkpoint?: Checkpoint;
}

export class SessionPauseResume {
  private readonly store: CheckpointStore;
  private readonly manager?: CheckpointManager;
  private readonly eventBus?: EventBus;
  /** sessionId → pause record */
  private readonly pauses = new Map<string, PauseRecord>();

  constructor(deps: { store: CheckpointStore; manager?: CheckpointManager; eventBus?: EventBus }) {
    this.store = deps.store;
    this.manager = deps.manager;
    this.eventBus = deps.eventBus;
  }

  /** Pause a run: checkpoint the state and record why. */
  async pause(input: {
    sessionId: string;
    reason: PauseReason;
    note?: string;
    state: AgentState;
    retryBudgets?: Record<string, number>;
  }): Promise<PauseRecord> {
    const checkpoint: Checkpoint = {
      id: ids.run(),
      sessionId: input.sessionId,
      label: `pause:${input.reason}`,
      version: CHECKPOINT_VERSION,
      createdAt: new Date().toISOString(),
      state: structuredClone(input.state),
      retryBudgets: input.retryBudgets ?? {},
    };
    await this.store.save(checkpoint);
    const record: PauseRecord = {
      checkpointId: checkpoint.id,
      sessionId: input.sessionId,
      reason: input.reason,
      at: new Date().toISOString(),
      ...(input.note ? { note: input.note } : {}),
    };
    this.pauses.set(input.sessionId, record);
    this.eventBus?.emitSync(
      makeEvent(input.sessionId, "checkpoint.saved", { label: checkpoint.label }),
    );
    return record;
  }

  /**
   * Strict validation of a checkpoint before any restore happens.
   * Returns every problem found — callers decide, this never mutates state.
   */
  async validateCheckpoint(checkpointId: string): Promise<ResumeValidation> {
    const problems: string[] = [];
    let cp: Checkpoint | undefined;
    try {
      cp = await this.store.load(checkpointId);
    } catch {
      problems.push("checkpoint storage unreadable");
    }
    if (!cp) return { ok: false, problems: ["checkpoint not found"], checkpoint: undefined };

    // Shape checks — treat stored JSON as untrusted.
    const raw = cp as Record<string, unknown> | null;
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, problems: ["checkpoint is not an object"], checkpoint: undefined };
    }
    if (typeof cp.sessionId !== "string" || cp.sessionId.length === 0) problems.push("missing sessionId");
    if (typeof cp.version !== "number") problems.push("missing version");
    else if (cp.version !== CHECKPOINT_VERSION) {
      problems.push(`incompatible checkpoint version ${cp.version} (runtime supports ${CHECKPOINT_VERSION})`);
    }
    if (!cp.state || typeof cp.state !== "object") {
      problems.push("missing state");
    } else {
      const st = cp.state as Record<string, unknown>;
      if (typeof st.goal !== "string") problems.push("state.goal missing");
      if (!Array.isArray(st.messages)) problems.push("state.messages missing");
      if (typeof st.sessionId !== "string") problems.push("state.sessionId missing");
      else if (cp.sessionId && st.sessionId !== cp.sessionId) problems.push("state.sessionId does not match checkpoint sessionId");
    }
    if (typeof cp.createdAt !== "string" || Number.isNaN(Date.parse(cp.createdAt))) {
      problems.push("invalid createdAt timestamp");
    }

    if (problems.length > 0) return { ok: false, problems, checkpoint: cp };
    return { ok: true, problems: [], checkpoint: cp };
  }

  /**
   * Resume: validate first (fail-closed), then return the restored state.
   * Throws a structured FluxError on invalid checkpoints — never a partial
   * restore. Callers re-create permission grants; none are restored here.
   */
  async resume(checkpointId: string, options: { expectedSessionId?: string } = {}): Promise<AgentState> {
    const validation = await this.validateCheckpoint(checkpointId);
    if (!validation.ok || !validation.checkpoint) {
      throw new FluxError({
        code: "E_CHECKPOINT_CORRUPT",
        message: `Checkpoint ${checkpointId} failed validation: ${validation.problems.join("; ")}`,
        hint: "The checkpoint was not restored. Start a new session or remove the corrupt checkpoint.",
      });
    }
    const cp = validation.checkpoint;
    if (options.expectedSessionId && cp.sessionId !== options.expectedSessionId) {
      throw new FluxError({
        code: "E_CHECKPOINT_CORRUPT",
        message: `Checkpoint belongs to session ${cp.sessionId}, expected ${options.expectedSessionId}`,
        hint: "Checkpoints cannot be resumed into a different session.",
      });
    }

    this.pauses.delete(cp.sessionId);
    this.eventBus?.emitSync(
      makeEvent(cp.sessionId, "checkpoint.restored", { label: cp.label }),
    );
    return structuredClone(cp.state);
  }

  /** Latest pause record for a session (undefined = not paused). */
  pauseFor(sessionId: string): PauseRecord | undefined {
    return this.pauses.get(sessionId);
  }

  /** All checkpoints for a session (for CLI listing). */
  listCheckpoints(sessionId: string) {
    return this.store.list(sessionId);
  }
}
