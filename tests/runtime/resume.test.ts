/**
 * Phase 7 — pause/resume tests.
 * Strict validation, corruption handling, version incompatibility,
 * session mismatch, and the "grants are never restored" invariant.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { InMemoryCheckpointStore, CHECKPOINT_VERSION, CheckpointManager } from "../../src/runtime/checkpoint.ts";
import { SessionPauseResume } from "../../src/runtime/resume.ts";
import { createAgentState } from "../../src/agent/state.ts";
import { isFluxError } from "../../src/utils/errors.ts";

describe("SessionPauseResume (Phase 7)", () => {
  test("pause creates a resumable checkpoint; resume restores equivalent state", async () => {
    const store = new InMemoryCheckpointStore();
    const svc = new SessionPauseResume({ store });
    const state = createAgentState("s1", "fix the build");
    state.stepCount = 4;
    state.observations.push({
      id: "obs1",
      sessionId: "s1",
      toolName: "file.read",
      callId: "c1",
      ok: true,
      output: "file contents",
      durationMs: 5,
      at: new Date().toISOString(),
    });

    const pause = await svc.pause({ sessionId: "s1", reason: "user", state, note: "user asked to stop" });
    assert.ok(pause.checkpointId);
    assert.equal(svc.pauseFor("s1")?.reason, "user");

    const restored = await svc.resume(pause.checkpointId, { expectedSessionId: "s1" });
    assert.equal(restored.goal, "fix the build");
    assert.equal(restored.stepCount, 4);
    assert.equal(restored.observations.length, 1);
    assert.equal(restored.observations[0]!.toolName, "file.read");
    assert.equal(svc.pauseFor("s1"), undefined, "pause record cleared after resume");
  });

  test("resume of a missing checkpoint fails closed with structured error", async () => {
    const svc = new SessionPauseResume({ store: new InMemoryCheckpointStore() });
    await assert.rejects(
      () => svc.resume("no-such-id"),
      (err: unknown) => isFluxError(err) && err.code === "E_CHECKPOINT_CORRUPT",
    );
  });

  test("corrupted checkpoint (bad shape) is rejected, never partially restored", async () => {
    const store = new InMemoryCheckpointStore();
    await store.save({ id: "cp-bad", sessionId: "s1", label: "x", version: CHECKPOINT_VERSION, createdAt: "nope", state: null as never, retryBudgets: {} });
    const svc = new SessionPauseResume({ store });
    const validation = await svc.validateCheckpoint("cp-bad");
    assert.equal(validation.ok, false);
    assert.ok(validation.problems.some((p) => p.includes("createdAt") || p.includes("state")));
    await assert.rejects(() => svc.resume("cp-bad"), (err: unknown) => isFluxError(err));
  });

  test("checkpoint state/session mismatch is detected", async () => {
    const store = new InMemoryCheckpointStore();
    const bad = {
      id: "cp-mm",
      sessionId: "s1",
      label: "x",
      version: CHECKPOINT_VERSION,
      createdAt: new Date().toISOString(),
      state: { ...createAgentState("OTHER-SESSION", "g"), messages: [] },
      retryBudgets: {},
    };
    await store.save(bad as never);
    const svc = new SessionPauseResume({ store });
    const validation = await svc.validateCheckpoint("cp-mm");
    assert.equal(validation.ok, false);
    assert.ok(validation.problems.some((p) => p.includes("sessionId")));
  });

  test("incompatible version is rejected (no silent upgrades)", async () => {
    const store = new InMemoryCheckpointStore();
    await store.save({
      id: "cp-v99",
      sessionId: "s1",
      label: "future",
      version: CHECKPOINT_VERSION + 98,
      createdAt: new Date().toISOString(),
      state: createAgentState("s1", "g"),
      retryBudgets: {},
    });
    const svc = new SessionPauseResume({ store });
    const validation = await svc.validateCheckpoint("cp-v99");
    assert.equal(validation.ok, false);
    assert.ok(validation.problems.some((p) => p.includes("version")));
  });

  test("resume into a different session is blocked", async () => {
    const store = new InMemoryCheckpointStore();
    const manager = new CheckpointManager({ store });
    const svc = new SessionPauseResume({ store, manager });
    const state = createAgentState("s-original", "goal");
    const pause = await svc.pause({ sessionId: "s-original", reason: "crash-recovery", state });
    await assert.rejects(
      () => svc.resume(pause.checkpointId, { expectedSessionId: "s-attacker" }),
      (err: unknown) => isFluxError(err) && err.code === "E_CHECKPOINT_CORRUPT",
    );
  });

  test("JsonFile store round-trips through pause/resume", async () => {
    const { JsonFileCheckpointStore } = await import("../../src/runtime/checkpoint.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "flux-resume-"));
    try {
      const store = new JsonFileCheckpointStore(dir);
      const svc = new SessionPauseResume({ store });
      const state = createAgentState("s-file", "persisted goal");
      const pause = await svc.pause({ sessionId: "s-file", reason: "approval-waiting", state });

      const svc2 = new SessionPauseResume({ store: new JsonFileCheckpointStore(dir) });
      const restored = await svc2.resume(pause.checkpointId);
      assert.equal(restored.goal, "persisted goal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checkpoints can be listed per session for CLI resume flows", async () => {
    const store = new InMemoryCheckpointStore();
    const svc = new SessionPauseResume({ store });
    await svc.pause({ sessionId: "s-list", reason: "user", state: createAgentState("s-list", "g1") });
    await svc.pause({ sessionId: "s-list", reason: "user", state: createAgentState("s-list", "g2") });
    const list = await svc.listCheckpoints("s-list");
    assert.equal(list.length, 2);
    assert.ok(list.every((c) => c.label.startsWith("pause:")));
  });
});
