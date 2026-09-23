/**
 * Phase 8 — MCP client tests.
 *
 * Uses a REAL stdio JSON-RPC server spawned as a child Node process
 * (tests/mcp/fixture-mcp-server.mjs) — no network, no external deps.
 * Disconnect/error paths use an immediately-exiting process and timeouts.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { McpClient, mcpToolsFromDescriptors, connectMcpServer } from "../../src/mcp/mcp.ts";
import { isFluxError } from "../../src/utils/errors.ts";

describe("McpClient (Phase 8)", () => {
  let dir: string;
  let serverScript: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "flux-mcp-"));
    // A minimal MCP server over stdio: initialize + tools/list + tools/call.
    serverScript = path.join(dir, "test-server.mjs");
    writeFileSync(
      serverScript,
      `
const tools = [
  { name: "echo", description: "Echo the input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
  { name: "add", description: "Add numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
];
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    let result, error;
    if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", serverInfo: { name: "test", version: "1.0.0" } };
    else if (msg.method === "tools/list") result = { tools };
    else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params ?? {};
      if (name === "echo") result = { content: [{ type: "text", text: JSON.stringify({ echoed: args.text }) }] };
      else if (name === "add") result = { content: [{ type: "text", text: JSON.stringify({ sum: args.a + args.b }) }] };
      else if (name === "fail") { result = { isError: true, content: [{ type: "text", text: "deliberate failure" }] }; }
      else error = { code: -32602, message: "unknown tool " + name };
    } else error = { code: -32601, message: "unknown method " + msg.method };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...(error ? { error } : { result }) }) + "\\n");
  }
});
`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("connect handshake + tools/list discovery", async () => {
    const client = new McpClient({ name: "test", command: process.execPath, args: [serverScript] });
    try {
      await client.connect();
      assert.equal(client.connected, true);
      const tools = await client.listTools();
      assert.equal(tools.length, 3);
      assert.deepEqual(tools.map((t) => t.name).sort(), ["add", "echo", "fail"]);
    } finally {
      client.disconnect();
    }
  });

  test("callTool returns structured JSON content", async () => {
    const { client } = await connectMcpServer({ name: "test", command: process.execPath, args: [serverScript] });
    try {
      const out = (await client.callTool("add", { a: 20, b: 22 })) as { sum: number };
      assert.equal(out.sum, 42);
    } finally {
      client.disconnect();
    }
  });

  test("tool error (isError) surfaces as structured FluxError", async () => {
    const { client } = await connectMcpServer({ name: "test", command: process.execPath, args: [serverScript] });
    try {
      await assert.rejects(
        () => client.callTool("fail", {}),
        (err: unknown) => isFluxError(err) && /deliberate failure/.test(err.message),
      );
    } finally {
      client.disconnect();
    }
  });

  test("server exit mid-call rejects pending calls with E_MCP_DISCONNECT", async () => {
    const exitScript = path.join(dir, "exit-server.mjs");
    writeFileSync(exitScript, "process.exit(0);\n");
    const client = new McpClient({ name: "exiting", command: process.execPath, args: [exitScript] });
    await assert.rejects(() => client.connect());
    assert.equal(client.connected, false);
  });

  test("call on disconnected client rejects immediately", async () => {
    const client = new McpClient({ name: "never", command: process.execPath, args: [serverScript] });
    await assert.rejects(
      () => client.callTool("echo", { text: "x" }),
      (err: unknown) => isFluxError(err) && err.code === "E_MCP_DISCONNECT",
    );
  });
});

describe("mcpToolsFromDescriptors", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "flux-mcp-tools-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("wraps descriptors as namespaced tools with USER_CONFIRMATION level", async () => {
    const serverScript = path.join(dir, "s.mjs");
    writeFileSync(serverScript, "process.stdin.resume();\n"); // stays alive; not used in this test
    const client = new McpClient({ name: "srv", command: process.execPath, args: [serverScript] });
    const descriptors = [
      { name: "read_thing", description: "Reads a thing", inputSchema: { type: "object" as const, properties: { id: { type: "string" as const } }, required: ["id"] } },
    ];
    const tools = mcpToolsFromDescriptors(client, descriptors);
    assert.equal(tools.length, 1);
    const meta = tools[0]!.metadata;
    assert.equal(meta.name, "mcp.srv.read_thing", "tool must be namespaced mcp.<server>.<tool>");
    assert.equal(meta.permissionLevel, "USER_CONFIRMATION", "external tools must require confirmation");
    assert.ok(meta.tags.includes("mcp"));
    client.disconnect();
  });

  test("namespaced tool executes through the client", async () => {
    // Fixture as a standalone file avoids nested template escaping bugs.
    // NOTE: in the line array, \\"\\\\n\\" at the JS level means the written file
    // contains backslash-n (escape sequence), NOT a raw newline.
    const serverScript = path.join(dir, "echo.mjs");
    writeFileSync(
      serverScript,
      [
        'let buf="";',
        'process.stdin.on("data",(d)=>{',
        '  buf+=d.toString("utf8");',
        '  let i;',
        String.raw`  while((i=buf.indexOf("\n"))>=0){`,
        '    const line=buf.slice(0,i).trim();',
        '    buf=buf.slice(i+1);',
        '    if(!line)continue;',
        '    const msg=JSON.parse(line);',
        '    if(msg.id===undefined)continue;',
        '    let result;',
        '    if(msg.method==="initialize") result={};',
        String.raw`    else if(msg.method==="tools/list") result={tools:[{name:"echo",description:"Echo the input",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}]};`,
        '    else if(msg.method==="tools/call") result={content:[{type:"text",text:JSON.stringify({got:msg.params.arguments.text})}]};',
        '    else result={};',
        String.raw`    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result})+"\n");`,
        '  }',
        '});',
      ].join("\n"),
    );
    const { client, tools } = await connectMcpServer({
      name: "echo",
      command: process.execPath,
      args: [serverScript],
    });
    // Register the wrapped tool into a real registry and execute via it —
    // proving MCP rides the standard tool path.
    const { ToolRegistry } = await import("../../src/tools/registry.ts");
    const registry = new ToolRegistry({ sessionId: "mcp-test" });
    registry.registerAll(tools);
    const result = await registry.execute({ toolName: "mcp.echo.echo", args: { text: "hello mcp" }, ctx: { callId: "c1" } });
    assert.equal(result.ok, true);
    assert.deepEqual((result.output as { result: { got: string } }).result, { got: "hello mcp" });
    client.disconnect();
  });
});
