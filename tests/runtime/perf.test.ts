/**
 * Phase 14 — performance regression tests.
 *
 * Measure-first regression guards: bounded budgets generous enough to be
 * stable on shared CI hardware, tight enough to catch gross regressions
 * (e.g. accidental O(n²) or repeated model calls). These are smoke budgets,
 * not benchmarks — the absolute numbers are recorded in the test output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "../../src/runtime/runtime.ts";
import { MockLlmProvider } from "../../src/llm/mock-provider.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolDiscovery } from "../../src/tools/discovery.ts";
import { ModelRouterService, mockModelDescriptor } from "../../src/llm/router.ts";
import { InMemoryShortTermMemory } from "../../src/memory/short-term.ts";
import { TtlCache, InMemoryStorage } from "../../src/runtime/observability.ts";

function measure(fn: () => void): number {
  const startedAt = performance.now();
  fn();
  return performance.now() - startedAt;
}

async function measureAsync(fn: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await fn();
  return performance.now() - startedAt;
}

test("perf: runtime startup (composition only) stays under 1500ms", async () => {
  const elapsed = await measureAsync(async () => {
    const runtime = createRuntime({ provider: new MockLlmProvider() });
    assert.ok(runtime.registry.list().length >= 30);
  });
  assert.ok(elapsed < 1500, `startup took ${Math.round(elapsed)}ms (budget 1500ms)`);
});

test("perf: full mock agent run stays under 2000ms", async () => {
  const elapsed = await measureAsync(async () => {
    const runtime = createRuntime({ provider: new MockLlmProvider() });
    const session = runtime.createSession({ goal: "read the file notes.txt" });
    const result = await session.agent.run("read the file notes.txt");
    assert.equal(result.status, "completed");
    await session.end("perf-done");
  });
  assert.ok(elapsed < 2000, `agent run took ${Math.round(elapsed)}ms (budget 2000ms)`);
});

test("perf: tool registry registration + lookup scale linearly (500 tools)", () => {
  const registry = new ToolRegistry({ sessionId: "perf" });
  const elapsed = measure(() => {
    for (let i = 0; i < 500; i++) {
      registry.register({
        metadata: { name: `tool_${i}`, description: "x", inputSchema: { type: "object" }, permissionLevel: "READ_ONLY", tags: [] },
        validate: () => {},
        execute: async () => ({ ok: true }),
      });
    }
    for (let i = 0; i < 500; i++) {
      assert.ok(registry.get(`tool_${i}`));
    }
  });
  assert.ok(elapsed < 800, `register+lookup of 500 tools took ${Math.round(elapsed)}ms (budget 800ms)`);
});

test("perf: discovery queries over 500 tools stay under 300ms", () => {
  const registry = new ToolRegistry({ sessionId: "perf" });
  for (let i = 0; i < 500; i++) {
    registry.register({
      metadata: { name: `file_op_${i}`, description: "file operation", inputSchema: { type: "object" }, permissionLevel: "READ_ONLY", tags: [] },
      validate: () => {},
      execute: async () => ({ ok: true }),
    });
  }
  const discovery = new ToolDiscovery(registry);
  const elapsed = measure(() => {
    for (let i = 0; i < 50; i++) {
      discovery.discover({ query: "read a file" });
    }
  });
  assert.ok(elapsed < 300, `50 discovery queries took ${Math.round(elapsed)}ms (budget 300ms)`);
});

test("perf: model routing selection stays under 20ms per decision", () => {
  const router = new ModelRouterService();
  router.registerModel(mockModelDescriptor());
  const elapsed = measure(() => {
    for (let i = 0; i < 100; i++) {
      assert.ok(router.selectOrDefault({ purpose: "generate", complexity: "deep", needsTools: true }));
    }
  });
  assert.ok(elapsed < 200, `100 route decisions took ${Math.round(elapsed)}ms (budget 200ms)`);
});

test("perf: short-term memory writes/readbacks stay under 100ms for 1k records", () => {
  const memory = new InMemoryShortTermMemory();
  const elapsed = measure(() => {
    for (let i = 0; i < 1000; i++) {
      memory.pushObservation({ id: `o${i}`, success: true, output: "x", metadata: {}, error: null, timestamp: new Date().toISOString() });
    }
    for (let i = 0; i < 1000; i++) {
      memory.recentObservations(10);
    }
  });
  assert.ok(elapsed < 100, `1k memory writes + 1k readbacks took ${Math.round(elapsed)}ms (budget 100ms)`);
});

test("perf: TTL cache throughput — 10k get/set ops under 150ms", () => {
  const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 1_000, namespace: "perf" });
  const elapsed = measure(() => {
    for (let i = 0; i < 10_000; i++) {
      cache.set(`k${i % 1000}`, i);
      cache.get(`k${i % 1000}`);
    }
  });
  assert.ok(elapsed < 150, `10k cache ops took ${Math.round(elapsed)}ms (budget 150ms)`);
});

test("perf: in-memory storage round-trips under 100ms for 1k keys", async () => {
  const storage = new InMemoryStorage();
  const elapsed = await measureAsync(async () => {
    for (let i = 0; i < 1000; i++) {
      await storage.set(`key:${i}`, "v");
    }
    for (let i = 0; i < 1000; i++) {
      await storage.get(`key:${i}`);
    }
  });
  assert.ok(elapsed < 100, `1k storage round-trips took ${Math.round(elapsed)}ms (budget 100ms)`);
});
