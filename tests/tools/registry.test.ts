/**
 * ToolRegistry tests: registration, lookup, validation, permission gating,
 * structured results.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "../../src/tools/registry.ts";
import { S, validateAgainstSchema } from "../../src/tools/schemas.ts";
import { defineTool } from "../../src/tools/tool.ts";
import { ToolNotFoundError, ToolArgumentsInvalidError } from "../../src/utils/errors.ts";

const echoSchema = S.object({ value: S.string("value to echo") }, ["value"]);

const echoTool = defineTool<{ value: string }, { echoed: string }>({
  metadata: {
    name: "test.echo",
    description: "echo the value",
    inputSchema: echoSchema,
    permissionLevel: "READ_ONLY",
    tags: ["test"],
  },
  validate(args: unknown): asserts args is { value: string } {
    const res = validateAgainstSchema(echoSchema, args);
    if (!res.valid) throw new Error(res.issues.join("; "));
  },
  async execute(args) {
    return { echoed: args.value };
  },
});

test("registry registers, lists, and finds tools", () => {
  const reg = new ToolRegistry({ sessionId: "t" });
  reg.register(echoTool);
  assert.ok(reg.has("test.echo"));
  assert.equal(reg.names()[0], "test.echo");
  const infos = reg.list();
  assert.equal(infos.length, 1);
  assert.equal(infos[0]!.name, "test.echo");
  assert.equal(infos[0]!.permissionLevel, "READ_ONLY");
});

test("registry rejects duplicate registration", () => {
  const reg = new ToolRegistry({ sessionId: "t" });
  reg.register(echoTool);
  assert.throws(() => reg.register(echoTool));
});

test("execute returns structured success", async () => {
  const reg = new ToolRegistry({ sessionId: "t" });
  reg.register(echoTool);
  const res = await reg.execute({ toolName: "test.echo", args: { value: "hi" } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.output, { echoed: "hi" });
  assert.ok(res.durationMs >= 0);
});

test("execute rejects unknown tool with typed error", async () => {
  const reg = new ToolRegistry({ sessionId: "t" });
  await assert.rejects(() => reg.execute({ toolName: "nope", args: {} }), ToolNotFoundError);
});

test("execute rejects invalid args with typed error", async () => {
  const reg = new ToolRegistry({ sessionId: "t" });
  reg.register(echoTool);
  await assert.rejects(() => reg.execute({ toolName: "test.echo", args: { wrong: 1 } }), ToolArgumentsInvalidError);
});

test("permission gate produces structured denial (not throw)", async () => {
  const reg = new ToolRegistry({ sessionId: "t" });
  reg.register(echoTool);
  const res = await reg.execute({
    toolName: "test.echo",
    args: { value: "x" },
    checkPermission: async () => false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "E_PERMISSION_DENIED");
});
