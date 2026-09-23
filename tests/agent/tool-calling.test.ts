/**
 * Phase 2 tests — native tool calling loop.
 *
 * A scriptable "tool-call provider" emits deterministic tool calls; the loop
 * must route every one through validation → permission → registry and feed
 * structured results back. No network, no real models.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ToolCallingLoop } from "../../src/agent/tool-calling.ts";
import type { LlmProvider, LlmGenerateOptions, PlannedPlan, AgentDecision } from "../../src/llm/provider.ts";
import type { LlmResponse, StreamChunk } from "../../src/llm/response.ts";
import type { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolRegistry as Registry } from "../../src/tools/registry.ts";
import { defineTool, type Tool } from "../../src/tools/tool.ts";
import { S } from "../../src/tools/schemas.ts";
import { PermissionManager } from "../../src/security/permission-manager.ts";
import type { ApprovalRequester, ApprovalRequest, ApprovalDecision } from "../../src/security/approval.ts";
import { EventBus } from "../../src/events/event-bus.ts";

// ── fixtures ───────────────────────────────────────────────────────────────────

interface ScriptedCall {
  readonly text?: string;
  readonly calls?: { id: string; name: string; args: Record<string, unknown> }[];
}

/** Provider that replays scripted turns, then finishes. */
class ToolCallScriptProvider implements LlmProvider {
  readonly name = "tool-script";
  readonly defaultModel = "script";
  private i = 0;
  private readonly script: readonly ScriptedCall[];
  readonly promptsSeen: LlmGenerateOptions[] = [];
  constructor(script: readonly ScriptedCall[]) {
    this.script = script;
  }
  async generate(options: LlmGenerateOptions): Promise<LlmResponse> {
    this.promptsSeen.push(options);
    const turn = this.script[Math.min(this.i, this.script.length - 1)]!;
    this.i++;
    return {
      text: turn.text ?? "",
      toolCalls: (turn.calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args })),
      stopReason: turn.calls && turn.calls.length > 0 ? "tool_calls" : "stop",
    };
  }
  async *stream(options: LlmGenerateOptions): AsyncGenerator<StreamChunk> {
    const res = await this.generate(options);
    if (res.text) yield { type: "text", value: res.text };
    for (const tc of res.toolCalls) yield { type: "tool_call", call: tc };
    yield { type: "done", finishReason: res.stopReason };
  }
  async plan(): Promise<PlannedPlan> {
    return { summary: "s", steps: [] };
  }
  async decideTool(): Promise<AgentDecision> {
    return { kind: "finish", thought: "t" };
  }
}

function makeRegistry(...tools: Tool[]): ToolRegistry {
  const reg = new Registry({ sessionId: "t" });
  reg.registerAll(tools);
  return reg;
}

function echoTool(): Tool {
  return defineTool({
    metadata: {
      name: "test.echo",
      description: "Echo input",
      inputSchema: S.object({ value: S.string("value") }, ["value"]),
      permissionLevel: "READ_ONLY",
      tags: [],
    },
    validate(args: unknown): asserts args is { value: string } {
      if (typeof (args as { value?: unknown }).value !== "string") throw new Error("value must be a string");
    },
    async execute(args) {
      return { echoed: args.value };
    },
  });
}

function addTool(): Tool {
  return defineTool({
    metadata: {
      name: "test.add",
      description: "Add numbers",
      inputSchema: S.object({ a: S.number("a"), b: S.number("b") }, ["a", "b"]),
      permissionLevel: "SAFE_WRITE",
      tags: [],
    },
    validate(args: unknown): asserts args is { a: number; b: number } {
      const { a, b } = args as { a?: unknown; b?: unknown };
      if (typeof a !== "number" || typeof b !== "number") throw new Error("a and b must be numbers");
    },
    async execute(args) {
      return { sum: args.a + args.b };
    },
  });
}

function dangerousTool(): Tool {
  return defineTool({
    metadata: {
      name: "test.danger",
      description: "Dangerous op",
      inputSchema: S.object({ target: S.string("target") }, ["target"]),
      permissionLevel: "PRIVILEGED",
      tags: [],
    },
    validate(args: unknown): asserts args is { target: string } {
      if (typeof (args as { target?: unknown }).target !== "string") throw new Error("target must be a string");
    },
    async execute(args) {
      return { destroyed: args.target };
    },
  });
}

function alwaysApprove(): ApprovalRequester {
  return {
    async request(request: ApprovalRequest): Promise<ApprovalDecision> {
      return { requestId: request.requestId, approved: true };
    },
  };
}

function autoDeny(): ApprovalRequester {
  return {
    async request(request: ApprovalRequest): Promise<ApprovalDecision> {
      return { requestId: request.requestId, approved: false, reason: "denied by test script" };
    },
  };
}

function permissionsFor(requester: ApprovalRequester): PermissionManager {
  return new PermissionManager({
    sessionId: "t",
    ceiling: "PRIVILEGED",
    approvalRequester: requester,
    autoApproveBelow: "SAFE_WRITE",
  });
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("ToolCallingLoop", () => {
  test("single tool call executes and feeds structured result to next turn", async () => {
    const registry = makeRegistry(echoTool());
    const provider = new ToolCallScriptProvider([
      { calls: [{ id: "c1", name: "test.echo", args: { value: "hi" } }] },
      { text: "done: hi" },
    ]);
    const loop = new ToolCallingLoop();
    const result = await loop.run({
      goal: "echo hi",
      registry,
      permissions: permissionsFor(alwaysApprove()),
      provider,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "done: hi");
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]!.ok, true);
    const parsed = JSON.parse(result.steps[0]!.resultForModel);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.echoed, "hi");
    // Second prompt must contain the tool result message.
    const second = provider.promptsSeen[1]!;
    const toolMsg = second.messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "tool result must be appended to the conversation");
  });

  test("multiple tool calls in one turn all execute in order", async () => {
    const registry = makeRegistry(echoTool(), addTool());
    const provider = new ToolCallScriptProvider([
      {
        calls: [
          { id: "c1", name: "test.add", args: { a: 2, b: 3 } },
          { id: "c2", name: "test.echo", args: { value: "x" } },
        ],
      },
      { text: "both done" },
    ]);
    const loop = new ToolCallingLoop();
    const result = await loop.run({
      goal: "two calls",
      registry,
      permissions: permissionsFor(alwaysApprove()),
      provider,
    });
    assert.equal(result.steps.length, 2);
    assert.equal(JSON.parse(result.steps[0]!.resultForModel).result.sum, 5);
    assert.equal(JSON.parse(result.steps[1]!.resultForModel).result.echoed, "x");
  });

  test("unknown tool returns structured error to the model, not a throw", async () => {
    const registry = makeRegistry(echoTool());
    const provider = new ToolCallScriptProvider([
      { calls: [{ id: "c1", name: "test.doesNotExist", args: {} }] },
      { text: "recovered" },
    ]);
    const loop = new ToolCallingLoop();
    const result = await loop.run({
      goal: "bad tool",
      registry,
      permissions: permissionsFor(alwaysApprove()),
      provider,
    });
    assert.equal(result.steps[0]!.ok, false);
    const parsed = JSON.parse(result.steps[0]!.resultForModel);
    assert.equal(parsed.error.code, "E_TOOL_NOT_FOUND");
    assert.equal(result.status, "completed", "loop continues after unknown tool");
  });

  test("schema-invalid arguments are rejected before execution", async () => {
    const registry = makeRegistry(echoTool());
    const provider = new ToolCallScriptProvider([
      { calls: [{ id: "c1", name: "test.echo", args: { value: 42 } }] },
      { text: "fixed" },
    ]);
    const loop = new ToolCallingLoop();
    const result = await loop.run({
      goal: "bad args",
      registry,
      permissions: permissionsFor(alwaysApprove()),
      provider,
    });
    assert.equal(result.steps[0]!.ok, false);
    const parsed = JSON.parse(result.steps[0]!.resultForModel);
    assert.equal(parsed.error.code, "E_TOOL_ARGUMENTS_INVALID");
    assert.equal(result.steps[0]!.observation.output, undefined, "invalid call must not produce output");
  });

  test("permission denial produces structured denial the model can see", async () => {
    const registry = makeRegistry(dangerousTool());
    const provider = new ToolCallScriptProvider([
      { calls: [{ id: "c1", name: "test.danger", args: { target: "X" } }] },
      { text: "understood, stopping" },
    ]);
    const loop = new ToolCallingLoop();
    const result = await loop.run({
      goal: "danger",
      registry,
      permissions: permissionsFor(autoDeny()),
      provider,
    });
    assert.equal(result.steps[0]!.ok, false);
    const parsed = JSON.parse(result.steps[0]!.resultForModel);
    assert.equal(parsed.error.code, "E_PERMISSION_DENIED");
    assert.equal(parsed.result, undefined, "denied call must not execute");
    assert.equal(JSON.stringify(parsed).includes("destroyed"), false);
  });

  test("privileged tool executes when approved (allow path stays intact)", async () => {
    const registry = makeRegistry(dangerousTool());
    const provider = new ToolCallScriptProvider([
      { calls: [{ id: "c1", name: "test.danger", args: { target: "approved-target" } }] },
      { text: "done" },
    ]);
    const loop = new ToolCallingLoop();
    const result = await loop.run({
      goal: "danger approved",
      registry,
      permissions: permissionsFor(alwaysApprove()),
      provider,
    });
    assert.equal(result.steps[0]!.ok, true);
    assert.equal(JSON.parse(result.steps[0]!.resultForModel).result.destroyed, "approved-target");
  });

  test("tool result size cap truncates oversized output", async () => {
    const big = defineTool({
      metadata: {
        name: "test.big",
        description: "Big output",
        inputSchema: S.object({}, []),
        permissionLevel: "READ_ONLY",
        tags: [],
      },
      validate(): void {},
      async execute() {
        return { blob: "z".repeat(50_000) };
      },
    });
    const registry = makeRegistry(big);
    const provider = new ToolCallScriptProvider([{ calls: [{ id: "c1", name: "test.big", args: {} }] }, { text: "ok" }]);
    const loop = new ToolCallingLoop();
    const result = await loop.run({
      goal: "big",
      registry,
      permissions: permissionsFor(alwaysApprove()),
      provider,
      maxToolResultChars: 1000,
    });
    assert.ok(result.steps[0]!.resultForModel.includes("truncated"));
    assert.ok(result.steps[0]!.resultForModel.length < 1200);
  });

  test("turn budget stops runaway loops with status max_turns", async () => {
    const registry = makeRegistry(echoTool());
    // Provider always calls the tool, never finishes.
    const provider = new ToolCallScriptProvider([{ calls: [{ id: "loop", name: "test.echo", args: { value: "again" } }] }]);
    const loop = new ToolCallingLoop();
    const result = await loop.run({
      goal: "runaway",
      registry,
      permissions: permissionsFor(alwaysApprove()),
      provider,
      maxTurns: 3,
    });
    assert.equal(result.status, "max_turns");
    assert.equal(result.turns, 3);
    assert.equal(result.steps.length, 3);
  });

  test("lifecycle events emitted for each call", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.pattern("tool.*", (e) => {
      seen.push(e.type);
    });
    const registry = makeRegistry(echoTool());
    const provider = new ToolCallScriptProvider([{ calls: [{ id: "c1", name: "test.echo", args: { value: "v" } }] }, { text: "fin" }]);
    const loop = new ToolCallingLoop();
    await loop.run({
      goal: "events",
      registry,
      permissions: permissionsFor(alwaysApprove()),
      provider,
      eventBus: bus,
    });
    assert.ok(seen.includes("tool.called"));
    assert.ok(seen.includes("tool.completed"));
  });

  test("tool executes against a real registry path (no bypass): direct execute reflects in steps", async () => {
    const registry = makeRegistry(addTool());
    const provider = new ToolCallScriptProvider([
      { calls: [{ id: "c1", name: "test.add", args: { a: 20, b: 22 } }] },
      { text: "sum done" },
    ]);
    const loop = new ToolCallingLoop();
    const result = await loop.run({
      goal: "add",
      registry,
      permissions: permissionsFor(alwaysApprove()),
      provider,
    });
    // Structured result flows through registry.execute — output shape proves it.
    const parsed = JSON.parse(result.steps[0]!.resultForModel);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.sum, 42);
  });
});
