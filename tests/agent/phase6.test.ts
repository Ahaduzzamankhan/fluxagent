/**
 * Phase 6 tests: task analysis, advanced decision engine, confidence system,
 * model router v2 (health/fallbacks), execution ledger, adaptive strategy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { HeuristicTaskAnalyzer } from "../../src/agent/task-analysis.ts";
import { AdvancedDecisionEngine, selectStrategy, STRATEGIES } from "../../src/agent/decision-advanced.ts";
import { confidence, combineConfidence, fromSuccessRate, confidenceLabel } from "../../src/agent/confidence.ts";
import { ModelRouterService, mockModelDescriptor } from "../../src/llm/router.ts";
import { ExecutionLedger, nextStrategyOnFailure } from "../../src/agent/execution-ledger.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolDiscovery } from "../../src/tools/discovery.ts";
import { createPlan, createStep } from "../../src/planning/plan.ts";
import { makeObservation } from "../../src/agent/state.ts";
import { S } from "../../src/tools/schemas.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function registryWithTool(name: string, level: "READ_ONLY" | "SAFE_WRITE" | "USER_CONFIRMATION" | "PRIVILEGED" = "READ_ONLY") {
  const reg = new ToolRegistry({ sessionId: "t" });
  reg.register({
    metadata: { name, description: "d", inputSchema: S.object({}), permissionLevel: level, tags: [] },
    validate(): void {},
    async execute() {
      return {};
    },
  });
  return reg;
}

function obsOk(tool: string, output: unknown) {
  return makeObservation({ sessionId: "s", toolName: tool, callId: "c", ok: true, output, durationMs: 5 });
}
function obsFail(tool: string, code: string, message: string, stepId?: string) {
  return makeObservation({
    sessionId: "s", toolName: tool, callId: "c", ok: false,
    error: { name: "FluxError", code: code as never, message, details: {} },
    durationMs: 5, ...(stepId ? { stepId } : {}),
  });
}

// ── task analysis ─────────────────────────────────────────────────────────────

test("task analyzer classifies goals and estimates complexity", () => {
  const a = new HeuristicTaskAnalyzer();

  const simple = a.analyze("read the file notes.txt");
  assert.equal(simple.type, "filesystem");
  assert.equal(simple.complexity, "simple");
  assert.equal(simple.reasoningLevel, "minimal");

  const multi = a.analyze("create a folder called X and then build a typescript project inside it");
  assert.equal(multi.complexity, "moderate");
  assert.ok(multi.signals.some((s) => /conjunctions|coding/.test(s)));

  const complex = a.analyze("analyze the trade-offs and decide which architecture to use", { previousFailures: 2 });
  assert.equal(complex.reasoningLevel, "deep");
  assert.ok(complex.estimatedComplexity > simple.estimatedComplexity);
});

test("task analyzer uses plan size and marks mixed domains", () => {
  const a = new HeuristicTaskAnalyzer();
  const s1 = createStep({ title: "a", description: "", tool: "file.read" });
  const s2 = createStep({ title: "b", description: "", tool: "file.write" });
  const s3 = createStep({ title: "c", description: "", tool: "file.read" });
  const s4 = createStep({ title: "d", description: "", tool: "file.write" });
  const plan = createPlan("g", "s", [s1, s2, s3, s4]);

  const analysis = a.analyze("organize all files", { plan });
  assert.ok(analysis.estimatedComplexity >= 0.35);
  assert.ok(analysis.impliedToolPrefixes.includes("file."));

  const mixed = a.analyze("take a screenshot of the code editor");
  assert.equal(mixed.type, "mixed");
});

// ── confidence system ─────────────────────────────────────────────────────────

test("confidence values clamp, weight by basis, and combine conservatively", () => {
  const verified = confidence(0.9, "verified", "goal-verdict");
  const model = confidence(0.99, "model-reported", "llm-says-fine");
  assert.equal(verified.weight, 0.9);
  assert.equal(model.weight, 0.3, "model-reported weighted at 0.3");
  assert.ok(model.weight < verified.weight);

  const combined = combineConfidence([verified, model]);
  assert.ok(combined.weight <= verified.weight + 0.01, "combination never exceeds strongest evidence");
  assert.equal(confidence(5, "heuristic", "x").value, 1, "clamps high");
  assert.equal(confidence(-1, "heuristic", "x").value, 0, "clamps low");

  assert.equal(fromSuccessRate(0, 0, "t").origin, "t:no-data");
  assert.equal(confidenceLabel(confidence(0.2, "verified", "x")), "low");
  assert.equal(confidenceLabel(confidence(0.95, "verified", "x")), "high");
});

// ── model router v2 ───────────────────────────────────────────────────────────

function routerWithModels(): ModelRouterService {
  const r = new ModelRouterService();
  r.registerModels([
    { id: "a:small", provider: "a", name: "small", capabilities: ["text", "tool-use", "fast"], quality: 4, cost: 2, maxInputTokens: 32_000 },
    { id: "b:big", provider: "b", name: "big", capabilities: ["text", "tool-use", "reasoning", "long-context"], quality: 9, cost: 8, maxInputTokens: 200_000 },
    { id: "c:embed", provider: "c", name: "embed", capabilities: ["text", "embedding"], quality: 5, cost: 3, maxInputTokens: 8_000 },
  ]);
  return r;
}

test("router v2: classification, embeddings, fallback chains, pinned model", () => {
  const r = routerWithModels();

  assert.equal(r.select({ purpose: "embed", complexity: "simple" })!.id, "c:embed", "embedding requests route to embedding models");
  assert.equal(r.select({ purpose: "code", complexity: "complex" })!.id, "b:big");
  assert.equal(r.select({ purpose: "summarize", complexity: "simple" })!.id, "a:small", "simple summarize prefers fast/cheap");

  const chain = r.routeWithFallbacks({ purpose: "plan", complexity: "complex" });
  assert.ok(chain.length >= 2, "fallback chain has alternates");
  assert.equal(chain[0]!.model.id, "b:big");
  assert.ok(chain.every((c) => c.healthy), "all healthy initially");

  const pinned = r.select({ purpose: "plan", complexity: "complex", pinnedModelId: "a:small" });
  assert.equal(pinned!.id, "a:small", "pinned model bypasses scoring");
});

test("router v2: health tracking deprioritizes failing models until reset", () => {
  const r = new ModelRouterService({ healthFailureThreshold: 2, healthResetMs: 50 });
  r.registerModel(mockModelDescriptor());
  r.registerModel({ id: "x:alt", provider: "x", name: "alt", capabilities: ["text", "tool-use"], quality: 8, cost: 5, maxInputTokens: 50_000 });

  assert.equal(r.select({ purpose: "plan", complexity: "moderate" })!.id, "x:alt");

  r.recordFailure("x:alt");
  r.recordFailure("x:alt");
  assert.equal(r.isHealthy("x:alt"), false, "opened after threshold");
  const after = r.select({ purpose: "plan", complexity: "moderate" });
  assert.equal(after!.id, "mock:deterministic", "unhealthy model loses priority");

  r.recordSuccess("x:alt", 120);
  assert.equal(r.isHealthy("x:alt"), true, "success resets health");
  assert.equal(r.healthSnapshot("x:alt").latencyMsAvg, 120);
});

// ── execution ledger ──────────────────────────────────────────────────────────

test("ledger records tool/model/strategy/recovery outcomes and reports reliability", () => {
  const l = new ExecutionLedger();
  l.recordToolOutcome("file.read", true, 10);
  l.recordToolOutcome("file.read", true, 30);
  l.recordToolOutcome("file.read", false, 20);
  assert.equal(l.toolSuccessRate("file.read"), 2 / 3);
  assert.equal(l.toolAvgDurationMs("file.read"), 20);

  l.recordToolOutcome("file.write", false, 5);
  l.recordToolOutcome("file.write", false, 5);
  l.recordToolOutcome("file.write", false, 5);
  const unreliable = l.unreliableTools(3, 0.5);
  assert.ok(unreliable.some((t) => t.tool === "file.write"));

  l.recordModelOutcome("m1", true, 100);
  l.recordModelOutcome("m1", false);
  l.recordStrategyOutcome("direct", true, 3);
  l.recordStrategyOutcome("direct", false, 2);
  l.recordRecoveryOutcome(true);
  l.recordRecoveryOutcome(false);

  const snap = l.snapshot();
  assert.equal(snap.models["m1"]!.successes, 1);
  assert.equal(snap.strategies["direct"]!.steps, 5);
  assert.equal(snap.recovery.succeeded, 1);
  assert.equal(l.rankedStrategies()[0]!.strategy, "direct");
  assert.equal(l.toolHistory().get("file.read")!.successes, 2);
});

// ── adaptive strategy ─────────────────────────────────────────────────────────

test("adaptive strategy escalates without repeating failures", () => {
  assert.equal(nextStrategyOnFailure({ tried: [], failureCategories: [], replansUsed: 0 }), "cautious");
  assert.equal(
    nextStrategyOnFailure({
      tried: [{ strategy: "cautious", outcome: "failure", at: new Date().toISOString() }],
      failureCategories: ["tool"],
      replansUsed: 1,
    }),
    "direct",
  );
  assert.equal(
    nextStrategyOnFailure({
      tried: [
        { strategy: "cautious", outcome: "failure", at: new Date().toISOString() },
        { strategy: "direct", outcome: "failure", at: new Date().toISOString() },
      ],
      failureCategories: ["tool", "network"],
      replansUsed: 2,
    }),
    "salvage",
    "all exhausted → salvage",
  );
  assert.equal(selectStrategy({
    analysis: new HeuristicTaskAnalyzer().analyze("read file.txt"),
    recentFailureCategories: ["tool"],
    replansUsed: 1,
    stepsExecuted: 2,
    maxSteps: 10,
  }).name, "salvage", "recent structural failures → salvage immediately");
  assert.equal(STRATEGIES.cautious.verifyFraction, 1);
});

// ── advanced decision engine ──────────────────────────────────────────────────

test("advanced decision engine enriches decisions with analysis, strategy, model, confidence", () => {
  const reg = registryWithTool("file.read", "READ_ONLY");
  const router = new ModelRouterService();
  router.registerModel({ id: "x:1", provider: "x", name: "1", capabilities: ["text", "tool-use"], quality: 7, cost: 4, maxInputTokens: 50_000 });

  const ledger = new ExecutionLedger();
  ledger.recordToolOutcome("file.read", true, 10);

  const engine = new AdvancedDecisionEngine({
    registry: reg,
    modelRouter: router,
    toolHistory: ledger.toolHistory(),
    discovery: new ToolDiscovery(reg),
  });

  const s = createStep({ title: "read notes", description: "", tool: "file.read" });
  const plan = createPlan("read the notes file", "s", [s]);
  const d = engine.decideAdvanced({
    goal: "read the notes file",
    plan,
    observations: [],
    replansUsed: 0,
    maxReplans: 2,
    stepsExecuted: 0,
    maxSteps: 10,
  });

  assert.equal(d.action, "execute-step");
  assert.equal(d.taskAnalysis.type, "filesystem");
  assert.ok(d.strategy, "strategy selected");
  assert.equal(d.routedModel!.id, "x:1");
  assert.ok(d.recommendedTools.some((t) => t.startsWith("file.")));
  assert.equal(d.confidenceEstimate.basis, "historical", "tool history present → strongest basis wins");
  assert.ok(d.confidenceEstimate.weight > 0);
  // Backward compat: base Decision fields intact.
  assert.equal(typeof d.confidence, "number");
  assert.ok(d.reason.length > 0);
});

test("advanced decision engine reacts to failures with salvage strategy", () => {
  const reg = registryWithTool("file.write", "SAFE_WRITE");
  const engine = new AdvancedDecisionEngine({ registry: reg });
  const s = createStep({ title: "w", description: "", tool: "file.write" });
  s.status = "failed";
  const plan = createPlan("write the file", "s", [s]);
  const d = engine.decideAdvanced({
    goal: "write the file",
    plan,
    observations: [obsFail("file.write", "E_TOOL_EXECUTION", "disk error", s.id)],
    replansUsed: 0,
    maxReplans: 2,
    stepsExecuted: 1,
    maxSteps: 10,
  });
  assert.equal(d.strategy.name, "salvage");
  assert.equal(d.diagnosisCategory, "tool");
  assert.equal(d.taskAnalysis.type, "filesystem");
  void obsOk;
});
