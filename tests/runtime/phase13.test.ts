/**
 * Phase 13 tests: TTL/LRU cache (incl. secret-key guard), resource limiter,
 * metrics registry, health registry, storage backends, and startup config
 * validation presets.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TtlCache,
  ResourceLimiter,
  MetricsRegistry,
  HealthRegistry,
  InMemoryStorage,
  JsonFileStorage,
} from "../../src/runtime/observability.ts";
import { resolveEnvConfig, validateStartupConfig, requireValidConfig } from "../../src/runtime/environments.ts";
import { DEFAULT_CONFIG } from "../../src/runtime/config.ts";

test("cache: TTL expiry and LRU eviction work with stats", async () => {
  const cache = new TtlCache<string>({ ttlMs: 20, maxEntries: 2, namespace: "test" });
  cache.set("a", "1");
  assert.equal(cache.get("a"), "1");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cache.get("a"), undefined, "expired entry");
  assert.equal(cache.stats().misses >= 1, true);

  cache.set("b", "2");
  cache.set("c", "3");
  cache.set("d", "4"); // evicts LRU (b)
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("c"), "3");
  assert.equal(cache.get("d"), "4");
  assert.equal(cache.stats().evictions, 1);
});

test("cache: refuses to cache secret-like keys without explicit policy", () => {
  const cache = new TtlCache<string>({ namespace: "safe" });
  assert.throws(() => cache.set("apiKey", "sk-123"), /secret/);
  assert.throws(() => cache.set("user_password", "x"), /secret/);

  const permissive = new TtlCache<string>({ namespace: "secrets", mayContainSecrets: true });
  permissive.set("apiKey", "sk-123"); // explicit override allowed
  assert.equal(permissive.get("apiKey"), "sk-123");
});

test("cache: getOrCompute dedupes concurrent computes and caches results", async () => {
  const cache = new TtlCache<number>({ ttlMs: 5_000, namespace: "dedupe" });
  let calls = 0;
  const compute = async (): Promise<number> => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return calls;
  };
  const [r1, r2, r3] = await Promise.all([cache.getOrCompute("k", compute), cache.getOrCompute("k", compute), cache.getOrCompute("k", compute)]);
  assert.equal(calls, 1, "single-flight");
  assert.equal(r1, r2);
  assert.equal(r3, r1);
  const again = await cache.getOrCompute("k", compute);
  assert.equal(calls, 1, "cached");
  assert.equal(again, r1);
});

test("resources: concurrency limit rejects beyond capacity and tickets release", () => {
  const limiter = new ResourceLimiter({ maxConcurrentTasks: 2, maxQueueSize: 1 });
  const t1 = limiter.tryAcquireTask();
  const t2 = limiter.tryAcquireTask();
  assert.ok(t1 && t2);
  assert.equal(limiter.tryAcquireTask(), null, "third acquire rejected");
  t1.release();
  const t3 = limiter.tryAcquireTask();
  assert.ok(t3, "release frees a slot");
  assert.equal(limiter.usage().concurrentTasks, 2);

  assert.equal(limiter.tryEnqueue(), true);
  assert.equal(limiter.tryEnqueue(), false, "queue full");
  limiter.dequeue();
  assert.equal(limiter.tryEnqueue(), true);
});

test("resources: per-minute call rate limiting with pruning", async () => {
  const limiter = new ResourceLimiter({ maxModelCallsPerMinute: 2, maxToolCallsPerMinute: 1 });
  assert.equal(limiter.recordModelCall(), true);
  assert.equal(limiter.recordModelCall(), true);
  assert.equal(limiter.recordModelCall(), false, "model budget exhausted");
  assert.equal(limiter.recordToolCall(), true);
  assert.equal(limiter.recordToolCall(), false);
  assert.equal(limiter.usage().modelCallsLastMinute, 2);
  assert.equal(limiter.usage().toolCallsLastMinute, 1);
});

test("metrics: counters, gauges, and histogram percentiles", () => {
  const metrics = new MetricsRegistry();
  metrics.increment("tool.calls");
  metrics.increment("tool.calls", 4);
  metrics.setGauge("queue.depth", 7);
  for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) metrics.observe("tool.duration", v);
  const snap = metrics.snapshot();
  assert.equal(snap.counters["tool.calls"], 5);
  assert.equal(snap.gauges["queue.depth"], 7);
  const h = snap.histograms["tool.duration"]!;
  assert.equal(h.count, 10);
  assert.equal(h.max, 100);
  assert.equal(h.p95, 100);
  assert.ok(h.avg > 40 && h.avg < 70);
});

test("health: aggregates check results and survives throwing checks", async () => {
  const health = new HealthRegistry();
  health.register({ name: "always-ok", check: () => ({ healthy: true, detail: "fine" }) });
  health.register({
    name: "boom",
    check: () => {
      throw new Error("kaboom");
    },
  });
  const result = await health.evaluate();
  assert.equal(result.healthy, false);
  const ok = result.checks.find((c) => c.name === "always-ok");
  const bad = result.checks.find((c) => c.name === "boom");
  assert.equal(ok?.healthy, true);
  assert.equal(bad?.healthy, false);
  assert.match(bad?.detail ?? "", /kaboom/);
});

test("storage: in-memory and json-file backends round-trip keys", async () => {
  const mem = new InMemoryStorage();
  await mem.set("task:1", "a");
  await mem.set("task:2", "b");
  await mem.set("other:3", "c");
  assert.deepEqual((await mem.keys("task:")).sort(), ["task:1", "task:2"]);
  assert.equal(await mem.get("task:1"), "a");
  await mem.delete("task:1");
  assert.equal(await mem.get("task:1"), null);

  const dir = await (await import("node:fs/promises")).mkdtemp(`${process.env["TEMP"] ?? "/tmp"}/flux-store-`);
  const fileStore = new JsonFileStorage(dir);
  await fileStore.set("checkpoint:s1", "hello");
  assert.equal(await fileStore.get("checkpoint:s1"), "hello");
  assert.deepEqual(await fileStore.keys("checkpoint:"), ["checkpoint:s1"]);
  await fileStore.delete("checkpoint:s1");
  assert.equal(await fileStore.get("checkpoint:s1"), null);
  assert.deepEqual(await fileStore.keys("nope"), []);
});

test("environments: resolveEnvConfig returns presets and rejects unknown", () => {
  assert.equal(resolveEnvConfig("development").environment, "development");
  assert.equal(resolveEnvConfig("production").api.authRequired, true);
  assert.equal(resolveEnvConfig("test").observability.metricsEnabled, false);
  assert.throws(() => resolveEnvConfig("staging-ish"), /unknown environment/);
});

test("environments: production validation enforces auth + no auto-approve + explicit roots", () => {
  const env = resolveEnvConfig("production");
  const badRuntime = { ...DEFAULT_CONFIG, security: { ...DEFAULT_CONFIG.security, mode: "auto-approve" as const, allowedRoots: [] as string[] } };
  const issues = validateStartupConfig(badRuntime, env);
  const paths = issues.map((i) => i.path);
  assert.ok(paths.includes("security.mode"), "auto-approve flagged in production");
  assert.ok(paths.includes("security.allowedRoots"), "empty roots flagged in production");

  const goodRuntime = {
    ...DEFAULT_CONFIG,
    security: { ...DEFAULT_CONFIG.security, mode: "ask" as const, allowedRoots: ["C:/workspace"], approvalTimeoutMs: 30_000 },
    logging: { ...DEFAULT_CONFIG.logging, level: "info" as const },
  };
  const okIssues = validateStartupConfig(goodRuntime, env);
  assert.equal(okIssues.filter((i) => i.path.startsWith("security") || i.path === "logging.level").length, 0);
  requireValidConfig(goodRuntime, env); // must not throw
});

test("environments: non-production auto-approve is accepted (dev convenience)", () => {
  const dev = resolveEnvConfig("development");
  const runtime = { ...DEFAULT_CONFIG, security: { ...DEFAULT_CONFIG.security, mode: "auto-approve" as const } };
  assert.equal(validateStartupConfig(runtime, dev).length, 0);
});
