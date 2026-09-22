/**
 * Phase 7 tests: reliability layer, task orchestrator (deps, parallelism,
 * priority queue, cancellation, timeouts, long-running checkpoint flow).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  withRetry,
  withTimeout,
  withFallback,
  CircuitBreaker,
  CircuitOpenError,
  executeReliably,
  RetryExhaustedError,
  delayForAttempt,
  DEFAULT_RETRY_POLICY,
} from "../../src/runtime/reliability.ts";
import {
  TaskOrchestrator,
  PriorityQueue,
  analyzeTaskGraph,
} from "../../src/runtime/task-orchestrator.ts";
import { TaskManager, TaskTransitionError } from "../../src/planning/task-manager.ts";

// ── reliability primitives ────────────────────────────────────────────────────

test("retry retries transient errors and reports history", async () => {
  let calls = 0;
  const result = await withRetry("op", async (attempt) => {
    calls++;
    if (attempt < 3) throw new Error("transient");
    return "ok";
  }, { maxAttempts: 5, baseDelayMs: 1, jitter: false });
  assert.equal(result.value, "ok");
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
  assert.equal(result.history.length, 2);
});

test("retry respects isRetryable and exhausts into RetryExhaustedError", async () => {
  const nonRetryable = await withRetry("op", async () => {
    throw Object.assign(new Error("bad args"), { permanent: true });
  }, { maxAttempts: 3, baseDelayMs: 1, isRetryable: (e) => !((e as { permanent?: boolean }).permanent) })
    .catch((e) => ({ name: e.name, message: e.message }));
  assert.match((nonRetryable as { message: string }).message, /bad args/);

  const exhausted = await withRetry("op", async () => {
    throw new Error("always");
  }, { maxAttempts: 3, baseDelayMs: 1 }).catch((e) => e);
  assert.ok(exhausted instanceof RetryExhaustedError);
  assert.equal(exhausted.details.attempts, 3);
});

test("retry never retries cancellation and never below maxAttempts=1", async () => {
  await assert.rejects(
    withRetry("op", async () => { throw new Error("first"); }, { maxAttempts: 1 }),
    /first/,
  );
  assert.equal(delayForAttempt(DEFAULT_RETRY_POLICY, 1) <= DEFAULT_RETRY_POLICY.maxDelayMs, true);
});

test("withTimeout cuts off signal-ignoring work", async () => {
  const slow = async (signal: AbortSignal) => {
    await new Promise((r) => setTimeout(r, 5_000));
    void signal;
    return "late";
  };
  const err = await withTimeout(slow, 30, "slow-op").catch((e) => e);
  assert.equal(err.code, "E_STEP_TIMEOUT");

  const fast = await withTimeout(async (signal) => {
    void signal;
    return "quick";
  }, 1_000);
  assert.equal(fast, "quick");
});

test("circuit breaker: closed → open → half-open → closed", async () => {
  const breaker = new CircuitBreaker("dep", { failureThreshold: 2, resetMs: 30 });
  assert.equal(breaker.currentState, "closed");

  const fail = () => breaker.execute(async () => { throw new Error("down"); });
  await fail().catch(() => {});
  assert.equal(breaker.currentState, "closed");
  await fail().catch(() => {});
  assert.equal(breaker.currentState, "open");

  const openErr = await breaker.execute(async () => "x").catch((e) => e);
  assert.ok(openErr instanceof CircuitOpenError, "fails fast while open");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(breaker.currentState, "half-open", "probe allowed after reset window");
  const probe = await breaker.execute(async () => "recovered");
  assert.equal(probe, "recovered");
  assert.equal(breaker.currentState, "closed");
});

test("withFallback degrades to first working implementation", async () => {
  const outcome = await withFallback([
    { name: "primary", run: async () => { throw new Error("dead"); } },
    { name: "secondary", run: async () => { throw new Error("also dead"); } },
    { name: "tertiary", run: async () => "saved" },
  ]);
  assert.equal(outcome.value, "saved");
  assert.equal(outcome.via, 2);
  assert.equal(outcome.degraded, true);

  const all = await withFallback([
    { name: "a", run: async () => { throw new Error("1"); } },
  ]).catch((e) => e);
  assert.ok(all instanceof RetryExhaustedError);
});

test("executeReliably composes retry + timeout + fallback", async () => {
  const direct = await executeReliably(async (signal) => {
    void signal;
    return 42;
  }, { operation: "op", timeoutMs: 1000 });
  assert.equal(direct.value, 42);
  assert.equal(direct.degraded, false);
  assert.equal(direct.via, "primary");

  const degraded = await executeReliably(async () => { throw new Error("nope"); }, {
    operation: "op",
    maxAttempts: 2,
    baseDelayMs: 1,
    fallbacks: [{ name: "cached", run: async () => 7 }],
  });
  assert.equal(degraded.value, 7);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.via, "cached");

  // Timeout inside the primary path triggers fallback too.
  const viaFallback = await executeReliably(
    async () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 1_000)),
    { operation: "slow", timeoutMs: 30, maxAttempts: 1, fallbacks: [{ name: "alt", run: async () => 5 }] },
  );
  assert.equal(viaFallback.value, 5);
  assert.equal(viaFallback.degraded, true);
});

// ── priority queue ────────────────────────────────────────────────────────────

test("priority queue: priority order, overdue boost, FIFO ties", () => {
  const q = new PriorityQueue<string>();
  q.push("low1", "low");
  q.push("crit1", "critical");
  q.push("norm1", "normal");
  q.push("crit2", "critical");
  assert.deepEqual(q.drain(), ["crit1", "crit2", "norm1", "low1"]);

  const q2 = new PriorityQueue<string>();
  q2.push("normal-early", "normal");
  q2.push("low-overdue", "low", true); // overdue boost: +10 rank
  assert.equal(q2.pop(), "low-overdue");
  assert.equal(q2.pop(), "normal-early");
});

// ── dependency graph ──────────────────────────────────────────────────────────

test("task graph: topological order and cycle detection", () => {
  const ok = analyzeTaskGraph([
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["a"] },
    { id: "d", dependsOn: ["b", "c"] },
  ]);
  assert.deepEqual(ok.order, ["a", "b", "c", "d"]);
  assert.equal(ok.cycles.length, 0);

  const cyclic = analyzeTaskGraph([
    { id: "x", dependsOn: ["y"] },
    { id: "y", dependsOn: ["x"] },
    { id: "z", dependsOn: [] },
  ]);
  assert.equal(cyclic.order.includes("z"), true);
  assert.equal(cyclic.cycles.length, 1);
  assert.deepEqual([...cyclic.cycles[0]!].sort(), ["x", "y"]);
});

// ── orchestrator ──────────────────────────────────────────────────────────────

function makeOrchestrator(overrides: Partial<ConstructorParameters<typeof TaskOrchestrator>[1]> = {}) {
  const tm = new TaskManager({ maxTasks: 100 });
  const orch = new TaskOrchestrator(tm, { concurrency: 4, baseDelayMs: 1, ...overrides });
  return { tm, orch };
}

test("orchestrator runs independent tasks in parallel under a concurrency limit", async () => {
  const { tm, orch } = makeOrchestrator({ concurrency: 2 });
  let concurrent = 0;
  let peak = 0;
  const jobs = ["a", "b", "c", "d", "e"];
  for (const j of jobs) {
    const t = tm.add({ goal: `task ${j}` });
    orch.submit(t, async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return j;
    });
  }
  await orch.waitForIdle();
  assert.equal(peak, 2, "concurrency limit respected");
  assert.equal(orch.status().completed, 5);
});

test("orchestrator honors dependencies: order and blocking", async () => {
  const { tm, orch } = makeOrchestrator();
  const order: string[] = [];
  const a = tm.add({ goal: "first" });
  const b = tm.add({ goal: "second", dependsOn: [a.id] });
  const c = tm.add({ goal: "third", dependsOn: [b.id] });
  orch.submit(a, async () => { order.push("a"); });
  orch.submit(b, async () => { order.push("b"); });
  orch.submit(c, async () => { order.push("c"); });
  await orch.waitForIdle();
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("orchestrator: higher priority runs first when capacity is constrained", async () => {
  const { tm, orch } = makeOrchestrator({ concurrency: 1 });
  const ran: string[] = [];
  const blocker = tm.add({ goal: "blocker" });
  orch.submit(blocker, async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  // Queue several while blocker occupies the single slot.
  const low = tm.add({ goal: "low job", priority: "low" });
  const high = tm.add({ goal: "high job", priority: "high" });
  const crit = tm.add({ goal: "crit job", priority: "critical" });
  orch.submit(low, async () => { ran.push("low"); });
  orch.submit(high, async () => { ran.push("high"); });
  orch.submit(crit, async () => { ran.push("crit"); });
  await orch.waitForIdle();
  assert.equal(ran[0], "crit");
  assert.equal(ran[1], "high");
  assert.equal(ran[2], "low");
});

test("orchestrator isolates failures: failed task does not kill siblings", async () => {
  const { tm, orch } = makeOrchestrator();
  const bad = tm.add({ goal: "will fail", priority: "high" });
  const good = tm.add({ goal: "will pass" });
  orch.submit(bad, async () => { throw new Error("boom"); });
  orch.submit(good, async () => "fine");
  await orch.waitForIdle();
  assert.equal(tm.get(bad.id)!.status, "failed");
  assert.equal(tm.get(good.id)!.status, "completed");

  const blocked = tm.add({ goal: "blocked child", dependsOn: [bad.id] });
  const blockedList = tm.blockedTasks();
  assert.equal(blockedList.some((b) => b.task.id === blocked.id), true);
  assert.throws(() => tm.update(bad.id, "active"), TaskTransitionError);
});

test("orchestrator retries transient failures then completes", async () => {
  const { tm, orch } = makeOrchestrator({ maxAttemptsPerTask: 3 });
  const t = tm.add({ goal: "flaky" });
  let calls = 0;
  orch.submit(t, async () => {
    calls++;
    if (calls < 3) throw new Error("flaky");
    return "ok";
  });
  await orch.waitForIdle();
  assert.equal(calls, 3);
  assert.equal(tm.get(t.id)!.status, "completed");
});

test("orchestrator: per-task timeout marks the task failed", async () => {
  const { tm, orch } = makeOrchestrator({ taskTimeoutMs: 40, maxAttemptsPerTask: 1 });
  const t = tm.add({ goal: "hangs", priority: "high" });
  orch.submit(t, async () => new Promise(() => {})); // never resolves
  await orch.waitForIdle();
  assert.equal(tm.get(t.id)!.status, "failed");
});

test("orchestrator: cancellation settles as cancelled", async () => {
  const { tm, orch } = makeOrchestrator({ taskTimeoutMs: undefined });
  const t = tm.add({ goal: "long running", priority: "high" });
  const t2 = tm.add({ goal: "long running 2", priority: "high" });
  let t2done = false;
  orch.submit(t, async (_task, { signal }) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    }));
  orch.submit(t2, async (_task, { signal }) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => { t2done = true; resolve(null); }, { once: true });
    }));
  await new Promise((r) => setTimeout(r, 20));
  orch.cancelAll("teardown");
  await orch.waitForIdle();
  assert.equal(tm.get(t.id)!.status, "cancelled");
  assert.equal(t2done, true, "second task saw its abort signal too");
});

test("orchestrator: long-running task checkpoint → pause → resume → complete", async () => {
  const { tm, orch } = makeOrchestrator({ concurrency: 1 });
  const checkpoints: string[] = [];
  const t = tm.add({ goal: "long task", priority: "high" });
  orch.submit(t, async (_task, { checkpoint, signal }) => {
    for (let i = 0; i < 5; i++) {
      if (signal.aborted) return null;
      await checkpoint();
      checkpoints.push(`step-${i}`);
      await new Promise((r) => setTimeout(r, 15));
    }
    return "done";
  });
  orch.pause(); // no effect on the running task, but blocks new ones
  await new Promise((r) => setTimeout(r, 30));
  orch.resume();
  await orch.waitForIdle();
  assert.equal(tm.get(t.id)!.status, "completed");
  assert.equal(checkpoints.length, 5);
});

test("orchestrator status reflects queue and terminal counts", async () => {
  const { tm, orch } = makeOrchestrator({ concurrency: 1 });
  const a = tm.add({ goal: "a", priority: "high" });
  orch.submit(a, async () => { await new Promise((r) => setTimeout(r, 20)); });
  const b = tm.add({ goal: "b" });
  orch.submit(b, async () => {});
  await new Promise((r) => setTimeout(r, 5));
  const mid = orch.status();
  assert.ok(mid.running <= 1);
  await orch.waitForIdle();
  const end = orch.status();
  assert.equal(end.completed, 2);
  assert.equal(end.running, 0);
});
