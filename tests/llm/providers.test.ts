/**
 * Phase 1 provider tests — BYOK adapters against local mock HTTP servers.
 *
 * These tests run REAL node:http servers on 127.0.0.1 and exercise the real
 * transport code path (headers, SSE parsing, error mapping). No external
 * network access, no real API keys.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { OpenAiCompatibleProvider } from "../../src/llm/providers/openai-compatible.ts";
import { AnthropicProvider } from "../../src/llm/providers/anthropic.ts";
import { LocalProvider } from "../../src/llm/providers/local.ts";
import { ProviderError } from "../../src/llm/providers/provider-errors.ts";
import { createProviderFromOptions } from "../../src/llm/providers/factory.ts";
import type { ToolInfo } from "../../src/tools/tool.ts";
import { S } from "../../src/tools/schemas.ts";

// ── test plumbing ──────────────────────────────────────────────────────────────

interface MockServer {
  readonly url: string;
  readonly requests: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[];
  close(): Promise<void>;
  /** Override the handler for the next test scenario. */
  handle(fn: (req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>) => void): void;
}

async function mockServer(): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  let handler: MockServer["handle"] extends (fn: infer F) => void ? F : never = (_req, res) => {
    res.writeHead(500).end(JSON.stringify({ error: { message: "no handler configured" } }));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        /* empty body */
      }
      requests.push({ path: req.url ?? "/", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    handle(fn) {
      handler = fn;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const tools: ToolInfo[] = [
  {
    name: "file.read",
    description: "Read a file",
    inputSchema: S.object({ path: S.string("path") }, ["path"]),
    permissionLevel: "READ_ONLY",
    tags: [],
  },
];

// ── OpenAI-compatible provider ─────────────────────────────────────────────────

describe("OpenAiCompatibleProvider", () => {
  test("generate: sends auth + tools, maps response and usage", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
    const p = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: "sk-test-123", defaultModel: "test-model" });
    const res = await p.generate({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools,
    });
    assert.equal(res.text, "hello world");
    assert.equal(res.stopReason, "stop");
    assert.equal(res.usage?.totalTokens, 15);
    const req = server.requests[0]!;
    assert.equal(req.headers.authorization, "Bearer sk-test-123");
    assert.equal(req.body.model, "test-model");
    const wireTools = req.body.tools as { function: { name: string } }[];
    assert.equal(wireTools[0]!.function.name, "file.read");
  });

  test("tool calling: arguments parsed into structured toolCalls", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(200).end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "c1", type: "function", function: { name: "file.read", arguments: '{"path":"/tmp/a.txt"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );
    });
    const p = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: "k", defaultModel: "m" });
    const res = await p.generate({ messages: [{ role: "user", content: [{ type: "text", text: "read" }] }] });
    assert.equal(res.stopReason, "tool_calls");
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0]!.name, "file.read");
    assert.equal(res.toolCalls[0]!.args.path, "/tmp/a.txt");
  });

  test("malformed tool-call arguments become structured provider errors, not crashes", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(200).end(
        JSON.stringify({
          choices: [
            { message: { tool_calls: [{ id: "c1", function: { name: "file.read", arguments: "{not json" } }] }, finish_reason: "tool_calls" },
          ],
        }),
      );
    });
    const p = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: "k", defaultModel: "m" });
    await assert.rejects(
      () => p.generate({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }),
      (e: unknown) => e instanceof ProviderError && e.kind === "UNKNOWN_PROVIDER_ERROR",
    );
  });

  test("streaming: text deltas and tool-call argument fragments reassemble", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "he" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "llo" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "file.", arguments: "" } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: '{"pa' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const p = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: "k", defaultModel: "m" });
    const chunks: { type: string; value?: string; call?: { name: string; args: Record<string, unknown> } }[] = [];
    for await (const c of p.stream({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] })) {
      chunks.push(c as { type: string; value?: string; call?: { name: string; args: Record<string, unknown> } });
    }
    const text = chunks.filter((c) => c.type === "text").map((c) => c.value).join("");
    assert.equal(text, "hello");
    const call = chunks.find((c) => c.type === "tool_call")?.call;
    assert.ok(call, "expected reassembled tool_call chunk");
    assert.equal(call!.name, "file.read");
    assert.equal(call!.args.path, "x");
    assert.equal(chunks.at(-1)?.type, "done");
  });

  test("error mapping: 401 → AUTHENTICATION_FAILED (key never in message)", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(401).end(JSON.stringify({ error: { message: "invalid key" } }));
    });
    const p = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: "sk-SUPER-SECRET-VALUE", defaultModel: "m" });
    try {
      await p.generate({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
      assert.fail("expected rejection");
    } catch (e) {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, "AUTHENTICATION_FAILED");
      assert.ok(!String((e as Error).message).includes("sk-SUPER-SECRET-VALUE"), "API key must never leak into errors");
      assert.equal((e as { code: string }).code, "E_LLM_AUTH_FAILED");
    }
  });

  test("error mapping: 429 with Retry-After → RATE_LIMITED with retryAfterMs", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(429, { "Retry-After": "2" }).end(JSON.stringify({ error: { message: "slow down" } }));
    });
    const p = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: "k", defaultModel: "m" });
    const err = (await p.generate({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }).catch((e) => e)) as ProviderError;
    assert.equal(err.kind, "RATE_LIMITED");
    assert.equal(err.retryAfterMs, 2000);
    assert.equal(err.retryable, true);
  });

  test("error mapping: connection refused → NETWORK_ERROR", async (t) => {
    // Port 1 on loopback is reliably closed.
    const p = new OpenAiCompatibleProvider({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", defaultModel: "m", timeoutMs: 2000 });
    const err = (await p.generate({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }).catch((e) => e)) as ProviderError;
    assert.equal(err.kind, "NETWORK_ERROR");
    assert.equal(err.code, "E_LLM_NETWORK");
  });

  test("timeout → TIMEOUT provider error", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      setTimeout(() => res.writeHead(200).end("{}"), 500);
    });
    const p = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: "k", defaultModel: "m", timeoutMs: 100 });
    const err = (await p.generate({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }).catch((e) => e)) as ProviderError;
    assert.equal(err.kind, "TIMEOUT");
  });

  test("plan(): parses JSON plan from text response", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(200).end(
        JSON.stringify({
          choices: [{ message: { content: 'here you go: {"summary":"s","steps":[{"id":"a","title":"t","tool":null}]}' }, finish_reason: "stop" }],
        }),
      );
    });
    const p = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: "k", defaultModel: "m" });
    const plan = await p.plan({ goal: "g", availableTools: [] });
    assert.equal(plan.summary, "s");
    assert.equal(plan.steps.length, 1);
  });
});

// ── Anthropic provider ─────────────────────────────────────────────────────────

describe("AnthropicProvider", () => {
  test("generate: system extracted, tools mapped to input_schema, response mapped", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(200).end(
        JSON.stringify({
          content: [{ type: "text", text: "hi there" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
      );
    });
    const p = new AnthropicProvider({ apiKey: "ak-TEST-SECRET", defaultModel: "claude-test", baseUrl: server.url });
    const res = await p.generate({
      messages: [
        { role: "system", content: [{ type: "text", text: "be brief" }] },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
      tools,
    });
    assert.equal(res.text, "hi there");
    assert.equal(res.usage?.totalTokens, 10);
    const req = server.requests[0]!;
    assert.equal(req.headers["x-api-key"], "ak-TEST-SECRET");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.body.system, "be brief");
    assert.equal((req.body.max_tokens as number) > 0, true);
    const wireTools = req.body.tools as { name: string; input_schema: unknown }[];
    assert.equal(wireTools[0]!.name, "file.read");
    assert.ok(wireTools[0]!.input_schema);
  });

  test("tool_use blocks become structured toolCalls", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(200).end(
        JSON.stringify({
          content: [{ type: "tool_use", id: "tu1", name: "file.read", input: { path: "/x" } }],
          stop_reason: "tool_use",
        }),
      );
    });
    const p = new AnthropicProvider({ apiKey: "k", defaultModel: "m", baseUrl: server.url });
    const res = await p.generate({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
    assert.equal(res.stopReason, "tool_calls");
    assert.equal(res.toolCalls[0]!.args.path, "/x");
  });

  test("tool_result messages map to user tool_result blocks", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => res.writeHead(200).end(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })));
    const p = new AnthropicProvider({ apiKey: "k", defaultModel: "m", baseUrl: server.url });
    await p.generate({
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "calling" }], toolCalls: [{ id: "tu1", name: "file.read", args: { path: "p" } }] },
        { role: "tool", content: [{ type: "tool_result", toolCallId: "tu1", content: "file body", isError: false }] },
      ],
    });
    const sent = server.requests[0]!.body.messages as { role: string; content: { type: string; tool_use_id?: string }[] }[];
    assert.equal(sent[2]!.role, "user");
    assert.equal(sent[2]!.content[0]!.type, "tool_result");
    assert.equal((sent[2]!.content[0] as { tool_use_id?: string }).tool_use_id, "tu1");
  });

  test("401 maps to AUTHENTICATION_FAILED; message stays secret-free", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => res.writeHead(401).end(JSON.stringify({ error: { message: "bad key" } })));
    const p = new AnthropicProvider({ apiKey: "ak-COUNT-TO-ZERO", defaultModel: "m", baseUrl: server.url });
    const err = (await p.generate({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }).catch((e) => e)) as ProviderError;
    assert.equal(err.kind, "AUTHENTICATION_FAILED");
    assert.ok(!err.message.includes("ak-COUNT-TO-ZERO"));
  });

  test("streaming: text_delta and input_json_delta reassemble", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu9", name: "file.read" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pat' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'h":"z"}' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}\n\n`);
      res.end();
    });
    const p = new AnthropicProvider({ apiKey: "k", defaultModel: "m", baseUrl: server.url });
    const chunks: { type: string; call?: { name: string; args: Record<string, unknown> } }[] = [];
    for await (const c of p.stream({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] })) {
      chunks.push(c as { type: string; call?: { name: string; args: Record<string, unknown> } });
    }
    const call = chunks.find((c) => c.type === "tool_call")?.call;
    assert.ok(call);
    assert.equal(call!.args.path, "z");
    assert.equal(chunks.at(-1)?.type, "done");
  });
});

// ── Local provider ─────────────────────────────────────────────────────────────

describe("LocalProvider", () => {
  test("works without a real API key against Ollama-style server", async (t) => {
    const server = await mockServer();
    t.after(() => server.close());
    server.handle((_req, res) => {
      res.writeHead(200).end(JSON.stringify({ choices: [{ message: { content: "local!" }, finish_reason: "stop" }] }));
    });
    const p = new LocalProvider({ baseUrl: server.url, defaultModel: "llama3" });
    const res = await p.generate({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    assert.equal(res.text, "local!");
  });

  test("provider descriptor registers in a ModelRouterService with local: prefix", async () => {
    const p = new LocalProvider({ baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "qwen2.5" });
    assert.equal(p.name, "local");
    assert.equal(p.defaultModel, "qwen2.5");
  });
});

// ── Factory ────────────────────────────────────────────────────────────────────

describe("provider factory", () => {
  test("creates openai-compatible provider from options with explicit key", () => {
    const p = createProviderFromOptions("openai-compatible", {
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "k",
      model: "m",
    });
    assert.equal(p.name, "openai-compatible");
  });

  test("resolves apiKeyEnv from the environment", () => {
    process.env.FLUXAGENT_TEST_PROVIDER_KEY = "env-resolved";
    try {
      const p = createProviderFromOptions("openai", {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKeyEnv: "FLUXAGENT_TEST_PROVIDER_KEY",
        model: "m",
      });
      assert.equal(p.name, "openai");
    } finally {
      delete process.env.FLUXAGENT_TEST_PROVIDER_KEY;
    }
  });

  test("missing key produces actionable error without echoing secrets", () => {
    assert.throws(
      () => createProviderFromOptions("anthropic", { model: "m" }),
      (e: Error) => e.message.includes("apiKeyEnv") && !e.message.includes("sk-"),
    );
  });

  test("local provider omits key requirement", () => {
    const p = createProviderFromOptions("local", { baseUrl: "http://127.0.0.1:11434/v1", model: "llama3" });
    assert.equal(p.name, "local");
  });

  test("invalid options fail fast with clear messages", () => {
    assert.throws(() => createProviderFromOptions("openai-compatible", { apiKey: "k", model: "m" }), /baseUrl/);
    assert.throws(() => createProviderFromOptions("anthropic", { apiKey: "k" }), /model/);
  });
});
