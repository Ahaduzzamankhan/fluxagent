/**
 * Phase 8 + 9 tests: universal API endpoints, authentication (API key
 * digests, local loopback, scopes), SSE streaming, TypeScript SDK client,
 * machine-readable API spec.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "../../src/runtime/runtime.ts";
import { MockLlmProvider } from "../../src/llm/mock-provider.ts";
import {
  AuthService,
  ApiKeyAuthenticator,
  LocalAuthenticator,
  generateApiKey,
  hasScope,
  EnvSecretProvider,
  InMemorySecretProvider,
  CompositeSecretProvider,
} from "../../src/api/auth.ts";
import { createApiServer } from "../../src/api/http-server.ts";
import { FluxAgentClient, FluxAgentApiError } from "../../src/sdk/client.ts";
import { apiSpec, toOpenApi, API_SPEC_VERSION } from "../../src/api/spec.ts";
import { ModelGateway } from "../../src/api/gateway.ts";
import { ModelRouterService, mockModelDescriptor } from "../../src/llm/router.ts";

async function startServer(auth?: AuthService) {
  const runtime = createRuntime({ provider: new MockLlmProvider() });
  const authService = auth ?? new AuthService([new LocalAuthenticator()]);
  const server = createApiServer({ runtime, auth: authService, port: 0, maxConcurrentRuns: 4 });
  await server.start();
  return { server, runtime };
}

// ── endpoints ─────────────────────────────────────────────────────────────────

test("API: health, tools, models endpoints return structured data", async () => {
  const { server } = await startServer();
  try {
    const health = await fetch(`${server.url}/health`).then((r) => r.json());
    assert.equal(health.status, "ok");
    assert.equal(health.version, "v1");
    assert.ok(health.tools > 0);

    const tools = await fetch(`${server.url}/tools`).then((r) => r.json());
    assert.ok(Array.isArray(tools.tools));
    assert.ok(tools.tools.some((t: { name: string }) => t.name === "file.read"));

    const models = await fetch(`${server.url}/models`).then((r) => r.json());
    assert.equal(models.models.length, 1);
    assert.equal(typeof models.models[0].healthy, "boolean");
  } finally {
    await server.stop();
  }
});

test("API: agent/run executes a goal and returns the result", async () => {
  const { server } = await startServer();
  try {
    const res = await fetch(`${server.url}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "read the file notes.txt" }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.result.status, "completed");
    assert.ok(body.sessionId.startsWith("sess_"));

    const sessions = await fetch(`${server.url}/sessions`).then((r) => r.json());
    assert.equal(sessions.sessions.length, 1);

    const single = await fetch(`${server.url}/sessions/${body.sessionId}`).then((r) => r.json());
    assert.equal(single.session.goal, "read the file notes.txt");
  } finally {
    await server.stop();
  }
});

test("API: validation errors are structured 400s", async () => {
  const { server } = await startServer();
  try {
    const res = await fetch(`${server.url}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error.code, "E_VALIDATION");

    const missing = await fetch(`${server.url}/sessions/sess_does_not_exist`);
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
  }
});

test("API: events endpoint returns recorded events after a run", async () => {
  const { server } = await startServer();
  try {
    await fetch(`${server.url}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "read the file a.txt" }),
    });
    const events = await fetch(`${server.url}/events?limit=200`).then((r) => r.json());
    assert.ok(events.events.length > 0);
    assert.ok(events.events.some((e: { type: string }) => e.type === "agent.started"));
  } finally {
    await server.stop();
  }
});

// ── SSE streaming ─────────────────────────────────────────────────────────────

test("API: SSE stream delivers live events for a run", async () => {
  const { server } = await startServer();
  try {
    // Start the run FIRST so the buffer holds events; the stream replays them.
    await fetch(`${server.url}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "read the file stream-test.txt" }),
    });

    const controller = new AbortController();
    const res = await fetch(`${server.url}/agent/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(text.includes("stream.open") && text.includes("agent.completed"))) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("agent.completed")) break;
    }
    controller.abort();
    try {
      reader.releaseLock();
    } catch {
      /* already released by abort */
    }
    assert.ok(text.includes("stream.open"), "stream.open event sent");
    assert.ok(text.includes("agent.started"), "buffered lifecycle events replayed");
    assert.ok(text.includes("agent.completed"), "completion event replayed");
  } finally {
    await server.stop();
  }
});

// ── auth ──────────────────────────────────────────────────────────────────────

test("auth: API keys authenticate via digest, wrong keys fail", async () => {
  const keyAuth = new ApiKeyAuthenticator();
  const key = generateApiKey();
  keyAuth.registerKey(key, { id: "cli-client", scopes: ["agent:run", "tools:read"] });

  const ok = await keyAuth.authenticate({ headers: { authorization: `Bearer ${key}` } });
  assert.ok(ok);
  assert.equal(ok!.id, "cli-client");
  assert.deepEqual(ok!.scopes.includes("agent:run"), true);

  const bad = await keyAuth.authenticate({ headers: { authorization: "Bearer fa_wrong" } });
  assert.equal(bad, null);
  const none = await keyAuth.authenticate({ headers: {} });
  assert.equal(none, null);

  assert.equal(keyAuth.keyCount, 1);
  assert.ok(key.length > 40, "generated keys are long random hex");
});

test("auth: local authenticator only trusts loopback", async () => {
  const local = new LocalAuthenticator();
  const loopback = await local.authenticate({ remoteAddress: "127.0.0.1" });
  assert.equal(loopback!.id, "loopback");
  const remote = await local.authenticate({ remoteAddress: "203.0.113.5" });
  assert.equal(remote, null);
});

test("auth: composite service and scope enforcement", async () => {
  const key = generateApiKey();
  const keyAuth = new ApiKeyAuthenticator();
  keyAuth.registerKey(key, { id: "limited", scopes: ["tools:read"] });
  const service = new AuthService([keyAuth, new LocalAuthenticator()]);

  const viaKey = await service.authenticate({ headers: { "x-api-key": key } });
  assert.equal(viaKey!.via, "api-key");
  assert.equal(hasScope(viaKey!.principal, "tools:read"), true);
  assert.equal(hasScope(viaKey!.principal, "agent:run"), false);

  // HTTP-level enforcement: limited key cannot run agents.
  const { server } = await startServer(new AuthService([keyAuth]));
  try {
    const denied = await fetch(`${server.url}/agent/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "x" }),
    });
    assert.equal(denied.status, 403);

    const allowed = await fetch(`${server.url}/tools`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(allowed.status, 200);
  } finally {
    await server.stop();
  }
});

test("auth: unauthenticated remote requests get 401", async () => {
  const { server } = await startServer(new AuthService([new ApiKeyAuthenticator()]));
  try {
    const res = await fetch(`${server.url}/tools`);
    assert.equal(res.status, 401);
  } finally {
    await server.stop();
  }
});

// ── secrets ───────────────────────────────────────────────────────────────────

test("secret providers: env lookup, memory, composite fallback", async () => {
  const memory = new InMemorySecretProvider();
  memory.setSecret("openai:api-key", "sk-test");
  const composite = new CompositeSecretProvider([memory, new EnvSecretProvider("FLUX_SECRET_")]);
  assert.equal(await composite.getSecret("openai:api-key"), "sk-test");
  assert.equal(await composite.getSecret("missing:secret"), null);
});

// ── model gateway ─────────────────────────────────────────────────────────────

test("model gateway: dispatch routes, records health, falls back", async () => {
  const router = new ModelRouterService();
  const gateway = new ModelGateway({ router });

  // registerProvider auto-registers a descriptor derived from the provider.
  const provider = new MockLlmProvider();
  gateway.registerProvider(provider);

  const result = await gateway.dispatch({
    messages: [{ role: "user", content: "hello" }],
    purpose: "generate",
    complexity: "simple",
  });
  assert.equal(result.modelId, "mock:mock:deterministic");
  assert.equal(result.response.text.length > 0, true);
  assert.ok(result.latencyMs >= 0);
  assert.equal(router.healthSnapshot("mock:mock:deterministic").successes, 1);

  assert.equal(gateway.capabilitiesFor("mock").includes("stream"), true);
});

// ── SDK client ────────────────────────────────────────────────────────────────

test("SDK: client covers health/tools/models/run/sessions/tasks/events", async () => {
  const { server } = await startServer();
  try {
    const client = new FluxAgentClient({ baseUrl: server.url });
    const health = await client.health();
    assert.equal(health.status, "ok");

    const tools = await client.listTools();
    assert.ok(tools.some((t) => t.name === "file.read"));

    const models = await client.listModels();
    assert.equal(models.length, 1);

    const run = await client.runAgent({ goal: "read the file sdk.txt" });
    assert.equal(run.result.status, "completed");
    assert.ok(run.sessionId.startsWith("sess_"));

    const sessions = await client.listSessions();
    assert.equal(sessions.length, 1);

    const events = await client.recentEvents(50);
    assert.ok(events.length > 0);

    await assert.rejects(
      client.getSession("sess_nope"),
      (err: unknown) => err instanceof FluxAgentApiError && err.status === 404,
    );
  } finally {
    await server.stop();
  }
});

test("SDK: typed event subscription receives streamed events", async () => {
  const { server } = await startServer();
  try {
    const client = new FluxAgentClient({ baseUrl: server.url });
    const seen: string[] = [];
    const off1 = client.on("agent.started", () => seen.push("started"));
    const off2 = client.on("tool.called", () => seen.push("tool"));
    // Run first so the event buffer has content, then consume the stream
    // (server replays buffered events to every new subscriber). The mock run
    // is read-only so no tool.call may occur — assert only on lifecycle.
    await client.runAgent({ goal: "read the file sdk-events.txt" });
    for await (const event of client.stream("read the file sdk-events.txt")) {
      if (event.type === "agent.completed") break;
    }
    off1();
    off2();
    client.disconnect();
    assert.ok(seen.includes("started"), "agent.started handler fired");
    assert.ok(seen.length >= 1, "at least one handler fired");
  } finally {
    await server.stop();
  }
});

// ── API spec ──────────────────────────────────────────────────────────────────

test("API spec: endpoint inventory and OpenAPI conversion", () => {
  const spec = apiSpec();
  assert.equal(spec.apiVersion, "v1");
  assert.ok(spec.endpoints.length >= 9);
  assert.ok(spec.endpoints.some((e) => e.path === "/api/v1/agent/run"));
  assert.ok(spec.endpoints.some((e) => e.path === "/api/v1/agent/stream"));
  assert.equal(spec.streaming.protocol, "sse");

  const openapi = toOpenApi();
  assert.equal(openapi.openapi, "3.1.0");
  const paths = openapi.paths as Record<string, unknown>;
  assert.ok(paths["/api/v1/agent/run"]);
  assert.ok(paths["/api/v1/health"]);
  assert.equal(API_SPEC_VERSION, "1.0.0");
});
