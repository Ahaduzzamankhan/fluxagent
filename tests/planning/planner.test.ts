/**
 * Planner + dependency tests: ordering, cycles, id remapping, revision,
 * unknown-tool handling.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Planner } from "../../src/agent/planner.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { analyzeDependencies, dependencyEdges } from "../../src/planning/dependency.ts";
import { dependenciesSatisfied, topoSort, createStep } from "../../src/planning/plan.ts";

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry({ sessionId: "t" });
  reg.register({
    metadata: {
      name: "file.write",
      description: "w",
      inputSchema: { type: "object" },
      permissionLevel: "SAFE_WRITE",
      tags: [],
    },
    validate(): void {},
    async execute() {
      return {};
    },
  });
  return reg;
}

test("buildPlan orders steps by dependencies and remaps LLM ids", () => {
  const planner = new Planner({ registry: makeRegistry() });
  const plan = planner.buildPlan("goal", {
    summary: "s",
    steps: [
      { id: "a", title: "first", tool: "file.write", args: {} },
      { id: "b", title: "second", tool: "file.write", args: {}, dependsOn: ["a"] },
      { id: "c", title: "third", tool: null, dependsOn: ["b"] },
    ],
  });
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0]!.title, "first");
  assert.equal(plan.steps[2]!.tool, null);
  assert.ok(plan.steps[2]!.dependsOn.length === 1);
  assert.equal(plan.steps[2]!.dependsOn[0], plan.steps[1]!.id, "dependsOn must be remapped to generated ids");
});

test("buildPlan rejects cycles", () => {
  const planner = new Planner({ registry: makeRegistry() });
  assert.throws(() =>
    planner.buildPlan("goal", {
      summary: "s",
      steps: [
        { id: "a", title: "a", tool: "file.write", dependsOn: ["b"] },
        { id: "b", title: "b", tool: "file.write", dependsOn: ["a"] },
      ],
    }),
  );
});

test("buildPlan rejects plans with no steps; unknown tools are kept for executor to fail", () => {
  const planner = new Planner({ registry: makeRegistry() });
  assert.throws(() => planner.buildPlan("g", { summary: "s", steps: [] }));
  const plan = planner.buildPlan("g", { summary: "s", steps: [{ title: "mystery", tool: "not.aTool" }] });
  assert.equal(plan.steps[0]!.tool, "not.aTool", "unknown tool names must not be silently dropped");
});

test("revise keeps completed steps and bumps revision", () => {
  const planner = new Planner({ registry: makeRegistry() });
  const plan = planner.buildPlan("g", {
    summary: "s",
    steps: [{ id: "a", title: "done", tool: "file.write" }, { id: "b", title: "pending", tool: "file.write" }],
  });
  plan.steps[0]!.status = "completed";
  const revised = planner.revise(plan, [{ title: "fix it", tool: "file.write" }], "recovery");
  assert.equal(revised.revision, 2);
  assert.equal(revised.steps[0]!.title, "done");
  assert.ok(revised.steps.some((s) => s.title === "fix it"));
});

test("dependency analysis classifies ready/blocked/failed", () => {
  const a = createStep({ title: "a", description: "a", tool: null });
  const b = createStep({ title: "b", description: "b", tool: null, dependsOn: [a.id] });
  const c = createStep({ title: "c", description: "c", tool: null, dependsOn: ["missing-id"] });
  assert.equal(dependenciesSatisfied(a, [a, b, c]), true);
  assert.equal(dependenciesSatisfied(b, [a, b, c]), false);
  const report = analyzeDependencies([a, b, c]);
  assert.deepEqual(report.readyStepIds, [a.id, c.id], "dangling deps are treated as satisfied");
  assert.deepEqual(report.blockedStepIds, [b.id]);
  const edges = dependencyEdges([a, b]);
  assert.deepEqual(edges, [{ from: a.id, to: b.id }]);
  void topoSort;
});
