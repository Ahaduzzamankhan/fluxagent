/**
 * End-to-end agent loop tests with a scripted provider and a real temp
 * directory. No network, no API keys.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createRuntime, DEFAULT_CONFIG } from "../../src/index.ts";
import { MockLlmProvider } from "../../src/llm/mock-provider.ts";
import type { PlannedPlan } from "../../src/llm/provider.ts";
import type { RuntimeConfig } from "../../src/runtime/config.ts";

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "fluxagent-test-"));
}

function configFor(dir: string, mode: RuntimeConfig["security"]["mode"]): RuntimeConfig {
  return {
    ...DEFAULT_CONFIG,
    memory: { longTermDirectory: ":memory:" },
    security: { ...DEFAULT_CONFIG.security, mode, allowedRoots: [dir], deniedRoots: [] },
  };
}

test("agent completes a multi-step file task end-to-end", async () => {
  const dir = await tmpDir();
  const target = path.join(dir, "hello.txt");

  const plan: PlannedPlan = {
    summary: "write then verify",
    steps: [
      { id: "w", title: "write file", tool: "file.write", args: { path: target, content: "flux" }, dependsOn: [] },
      { id: "v", title: "verify exists", tool: "file.exists", args: { path: target }, dependsOn: ["w"] },
    ],
  };

  const runtime = createRuntime({
    provider: new MockLlmProvider({ plan }),
    config: configFor(dir, "auto-approve"),
    cwd: dir,
  });

  const session = runtime.createSession({ goal: "write hello.txt" });
  const result = await session.agent.run("write hello.txt");

  assert.equal(result.status, "completed");
  assert.equal(result.stepsCompleted, 2);
  const state = session.state.get();
  assert.ok(state.plan);
  assert.equal(state.plan!.steps[1]!.status, "completed");
  const finalText = await readFile(target, "utf8");
  assert.equal(finalText, "flux");
});

test("agent respects denied permissions and reports blocked step", async () => {
  const dir = await tmpDir();
  const target = path.join(dir, "blocked.txt");

  const plan: PlannedPlan = {
    summary: "single write",
    steps: [{ id: "w", title: "write file", tool: "file.write", args: { path: target, content: "x" } }],
  };

  const runtime = createRuntime({
    provider: new MockLlmProvider({ plan }),
    config: configFor(dir, "deny-all"),
    cwd: dir,
  });

  const session = runtime.createSession({ goal: "write blocked" });
  const result = await session.agent.run("write blocked");

  assert.equal(result.status, "failed");
  const state = session.state.get();
  const step = state.plan!.steps[0]!;
  assert.equal(step.status, "blocked", "permission-denied steps must end blocked, not silently failed");
  assert.ok(
    state.permissionLog.some((p) => p.outcome === "denied"),
    "denial must be recorded in the permission log",
  );
});

test("agent terminates on unknown tool without hanging", async () => {
  const dir = await tmpDir();

  const plan: PlannedPlan = {
    summary: "bad tool",
    steps: [{ id: "x", title: "use missing tool", tool: "file.doesNotExist", args: {} }],
  };

  const runtime = createRuntime({
    provider: new MockLlmProvider({ plan }),
    config: configFor(dir, "auto-approve"),
    cwd: dir,
  });

  const session = runtime.createSession({ goal: "bad tool test" });
  const result = await session.agent.run("bad tool test");
  assert.equal(result.status, "failed");
  assert.ok(stateHasFailure(session.state.get()));
});

function stateHasFailure(state: { plan: { steps: { status: string; error?: unknown }[] } | null }): boolean {
  return !!state.plan?.steps.some((s) => s.status === "failed");
}
