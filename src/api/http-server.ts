/**
 * FluxAgent — universal HTTP API (Phase 8.1 + 8.3).
 *
 * A dependency-free node:http server exposing the runtime:
 *
 *   GET  /api/v1/health
 *   GET  /api/v1/tools
 *   GET  /api/v1/models
 *   GET  /api/v1/providers           model gateway providers (no key material)
 *   GET  /api/v1/skills              registered skills + readiness
 *   GET  /api/v1/memory/semantic     semantic memory stats + search (?q=)
 *   GET  /api/v1/permissions/:sid    audit trail + active grants for a session
 *   POST /api/v1/agent/run            { goal, sessionId? } → run result
 *   GET  /api/v1/agent/stream?goal=…  SSE stream of live agent events
 *   GET  /api/v1/events               recent recorded events (JSON)
 *   GET  /api/v1/sessions, /api/v1/sessions/:id
 *   GET  /api/v1/tasks, /api/v1/tasks/:id
 *
 * Streaming protocol: SSE with `event:` = AgentEvent type and `data:` = JSON
 * event payload. No chain-of-thought is exposed — events are the same typed
 * AgentEvent records the internal bus carries. Auth via AuthService
 * (Phase 8.4); loopback requests are authenticated by the LocalAuthenticator
 * by default.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { FluxRuntime, FluxSession } from "../runtime/runtime.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { AgentEvent } from "../events/events.ts";
import type { Logger } from "../utils/logger.ts";
import { toFluxError } from "../utils/errors.ts";
import type { AuthService, AuthScope } from "./auth.ts";

export const API_VERSION = "v1";

export interface ApiServerOptions {
  readonly runtime: FluxRuntime;
  readonly auth: AuthService;
  readonly port?: number;
  readonly host?: string;
  readonly logger?: Logger;
  /** Max recent events buffered for GET /events and new SSE subscribers. */
  readonly eventBufferSize?: number;
  /** Max concurrent agent runs accepted (0/undefined = unlimited). */
  readonly maxConcurrentRuns?: number;
}

export interface ApiServer {
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createApiServer(options: ApiServerOptions): ApiServer {
  const { runtime, auth } = options;
  const logger = options.logger;
  const bufferLimit = options.eventBufferSize ?? 500;
  const eventBuffer: AgentEvent[] = [];
  const sseClients = new Set<{ id: string; write: (chunk: string) => void; sessionFilter?: string }>();
  let activeRuns = 0;

  // Buffer + fan out all session events through a runtime-level tap.
  const tap = (event: AgentEvent): void => {
    eventBuffer.push(event);
    if (eventBuffer.length > bufferLimit) eventBuffer.shift();
    const payload = JSON.stringify(event);
    for (const client of sseClients) {
      if (client.sessionFilter && client.sessionFilter !== event.sessionId) continue;
      try {
        client.write(`event: ${event.type}\ndata: ${payload}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  // Tap events from every session bus — sessions register when created.
  const originalCreateSession = runtime.createSession.bind(runtime);
  const tappedCreateSession = (opts: { goal?: string } = {}): FluxSession => {
    const session = originalCreateSession(opts);
    session.bus.any((e) => {
      tap(e as AgentEvent);
    });
    return session;
  };
  (runtime as { createSession: typeof tappedCreateSession }).createSession = tappedCreateSession;

  const sessions = new Map<string, FluxSession>();
  const sessionsList = (): FluxSession[] => [...sessions.values()];

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger?.error("api handler crashed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        json(res, 500, { error: { code: "E_INTERNAL", message: "internal server error" } });
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const remote = req.socket.remoteAddress ?? "";
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;

    // ── CORS for local/dev clients (API consumers may be browsers) ─────────
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ── authentication ──────────────────────────────────────────────────
      const publicPaths = new Set([`/api/${API_VERSION}/health`]);
      let scope: AuthScope = "agent:run";
      if (path.startsWith(`/api/${API_VERSION}/tasks`)) scope = req.method === "GET" ? "tasks:read" : "tasks:write";
      else if (path.startsWith(`/api/${API_VERSION}/tools`) || path.startsWith(`/api/${API_VERSION}/models`)) scope = "tools:read";
      else if (path.startsWith(`/api/${API_VERSION}/events`)) scope = "events:read";
      else if (path.startsWith(`/api/${API_VERSION}/sessions`)) scope = req.method === "GET" ? "sessions:read" : "sessions:write";

      if (!publicPaths.has(path)) {
        const result = await auth.authenticate({ headers, remoteAddress: remote });
        if (!result) {
          json(res, 401, { error: { code: "E_PERMISSION_DENIED", message: "authentication required" } });
          return;
        }
        if (scope === "agent:run" && !result.principal.scopes.includes("agent:run") && !result.principal.scopes.includes("admin")) {
          json(res, 403, { error: { code: "E_PERMISSION_DENIED", message: `missing scope "${scope}"` } });
          return;
        }
        if (scope !== "agent:run" && !result.principal.scopes.includes(scope) && !result.principal.scopes.includes("admin")) {
          json(res, 403, { error: { code: "E_PERMISSION_DENIED", message: `missing scope "${scope}"` } });
          return;
        }
      }

      // ── routing ─────────────────────────────────────────────────────────
      if (req.method === "GET" && path === `/api/${API_VERSION}/health`) {
        json(res, 200, {
          status: "ok",
          version: API_VERSION,
          uptimeMs: Math.round(process.uptime() * 1000),
          sessions: sessionsList().length,
          activeRuns,
          models: runtime.modelRouter.listModels().length,
          tools: runtime.registry.list().length,
        });
        return;
      }

      if (req.method === "GET" && path === `/api/${API_VERSION}/tools`) {
        json(res, 200, { version: API_VERSION, tools: runtime.registry.list() });
        return;
      }

      if (req.method === "GET" && path === `/api/${API_VERSION}/models`) {
        json(res, 200, {
          version: API_VERSION,
          models: runtime.modelRouter.listModels().map((m) => ({
            ...m,
            health: runtime.modelRouter.healthSnapshot(m.id),
            healthy: runtime.modelRouter.isHealthy(m.id),
          })),
        });
        return;
      }

      // ── Phase 10–11 integration endpoints ─────────────────────────────────

      // Providers: identity + capabilities only. NEVER expose API keys —
      // the runtime holds secrets opaquely and this surface stays key-free.
      if (req.method === "GET" && path === `/api/${API_VERSION}/providers`) {
        const providerList = runtime.listProviders();
        json(res, 200, {
          version: API_VERSION,
          providers: providerList.map((p) => ({
            id: p.id,
            kind: p.kind,
            baseUrl: p.baseUrl,
            hasApiKey: p.hasApiKey,
            models: p.models,
          })),
        });
        return;
      }

      if (req.method === "GET" && path === `/api/${API_VERSION}/skills`) {
        const skills = runtime.listSkills();
        json(res, 200, {
          version: API_VERSION,
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
            version: s.version,
            requiredTools: s.requiredTools,
            ready: s.ready,
            missingTools: s.missingTools,
          })),
        });
        return;
      }

      if (req.method === "GET" && path === `/api/${API_VERSION}/memory/semantic`) {
        const q = url.searchParams.get("q");
        const stats = await runtime.semanticMemoryStats();
        const hits = q ? await runtime.semanticMemorySearch(q, 10) : [];
        json(res, 200, { version: API_VERSION, stats, results: hits });
        return;
      }

      const permMatch = path.match(new RegExp(`^/api/${API_VERSION}/permissions/([^/]+)$`));
      if (req.method === "GET" && permMatch) {
        const session = sessions.get(permMatch[1]!);
        if (!session) {
          json(res, 404, { error: { code: "E_SESSION_NOT_FOUND", message: `session ${permMatch[1]} not found` } });
          return;
        }
        json(res, 200, {
          version: API_VERSION,
          sessionId: permMatch[1]!,
          ceiling: session.permissions.currentCeiling(),
          activeGrants: session.permissions.activeGrants(),
          audit: session.permissions.auditTrail().slice(0, 100),
        });
        return;
      }

      if (req.method === "GET" && path === `/api/${API_VERSION}/events`) {
        const since = url.searchParams.get("since");
        let events = eventBuffer;
        if (since) events = events.filter((e) => e.timestamp > since);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        json(res, 200, { version: API_VERSION, events: events.slice(-Math.min(limit, bufferLimit)) });
        return;
      }

      if (req.method === "GET" && path === `/api/${API_VERSION}/agent/stream`) {
        handleSse(req, res, url);
        return;
      }

      if (req.method === "POST" && path === `/api/${API_VERSION}/agent/run`) {
        const body = await readJson(req);
        const goal = typeof (body as { goal?: unknown }).goal === "string" ? (body as { goal: string }).goal : "";
        if (!goal.trim()) {
          json(res, 400, { error: { code: "E_VALIDATION", message: "field \"goal\" is required" } });
          return;
        }
        if (options.maxConcurrentRuns !== undefined && activeRuns >= options.maxConcurrentRuns) {
          json(res, 429, { error: { code: "E_SESSION_ALREADY_RUNNING", message: "too many concurrent runs" } });
          return;
        }
        const session = getOrCreateSession((body as { sessionId?: string }).sessionId, goal);
        activeRuns++;
        try {
          const result = await session.agent.run(goal);
          json(res, 200, { version: API_VERSION, sessionId: session.id, result });
        } finally {
          activeRuns--;
        }
        return;
      }

      if (req.method === "GET" && path === `/api/${API_VERSION}/sessions`) {
        json(res, 200, {
          version: API_VERSION,
          sessions: sessionsList().map((s) => ({
            id: s.id,
            goal: s.state.get().goal,
            planId: s.state.get().plan?.id ?? null,
            observations: s.state.get().observations.length,
          })),
        });
        return;
      }

      const sessionMatch = path.match(new RegExp(`^/api/${API_VERSION}/sessions/([^/]+)$`));
      if (req.method === "GET" && sessionMatch) {
        const session = sessions.get(sessionMatch[1]!);
        if (!session) {
          json(res, 404, { error: { code: "E_SESSION_NOT_FOUND", message: `session ${sessionMatch[1]} not found` } });
          return;
        }
        json(res, 200, { version: API_VERSION, session: session.state.get() });
        return;
      }

      // Task orchestration endpoints (Phase 7 TaskManager state, read model).
      const taskManager = sessionsList()[0]?.taskManager;
      if (req.method === "GET" && path === `/api/${API_VERSION}/tasks`) {
        json(res, 200, {
          version: API_VERSION,
          tasks: (taskManager?.list() ?? []).map((t) => ({
            id: t.id, goal: t.goal, status: t.status, priority: t.priority,
            dependsOn: t.dependsOn, createdAt: t.createdAt, updatedAt: t.updatedAt,
          })),
        });
        return;
      }
      const taskMatch = path.match(new RegExp(`^/api/${API_VERSION}/tasks/([^/]+)$`));
      if (req.method === "GET" && taskMatch) {
        const t = taskManager?.get(taskMatch[1]!);
        if (!t) {
          json(res, 404, { error: { code: "E_VALIDATION", message: `task ${taskMatch[1]} not found` } });
          return;
        }
        json(res, 200, { version: API_VERSION, task: t });
        return;
      }

      json(res, 404, { error: { code: "E_VALIDATION", message: `no route: ${req.method} ${path}` } });
    } catch (err) {
      const flux = toFluxError(err);
      const status = flux.code === "E_VALIDATION" ? 400 : flux.code === "E_PERMISSION_DENIED" ? 403 : 500;
      json(res, status, { error: { code: flux.code, message: flux.message } });
    }
  }

  function handleSse(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const id = `sse-${Math.random().toString(36).slice(2, 10)}`;
    const sessionFilter = url.searchParams.get("sessionId") ?? undefined;

    res.write(`retry: 2000\n\n`);
    // Replay the buffer so subscribers have context.
    for (const e of eventBuffer) {
      if (sessionFilter && e.sessionId !== sessionFilter) continue;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    }
    res.write(`event: stream.open\ndata: ${JSON.stringify({ id, filter: sessionFilter ?? "all" })}\n\n`);

    const client = {
      id,
      sessionFilter,
      write: (chunk: string) => res.write(chunk),
    };
    sseClients.add(client);
    logger?.debug("sse client connected", { id, clients: sseClients.size });

    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* closed */
      }
    }, 15_000);
    heartbeat.unref?.();

    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
      logger?.debug("sse client disconnected", { id, clients: sseClients.size });
    });
  }

  function getOrCreateSession(sessionId: string | undefined, goal: string): FluxSession {
    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (existing) return existing;
      throw Object.assign(new Error(`session ${sessionId} not found`), { code: "E_SESSION_NOT_FOUND" });
    }
    const session = runtime.createSession({ goal });
    sessions.set(session.id, session);
    return session;
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  return {
    get port(): number {
      return (server.address() as AddressInfo)?.port ?? options.port ?? 0;
    },
    get url(): string {
      return `http://127.0.0.1:${this.port}/api/${API_VERSION}`;
    },
    async start(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
      });
      logger?.info("api server started", { url: `http://127.0.0.1:${this.port}/api/${API_VERSION}` });
    },
    async stop(): Promise<void> {
      for (const client of sseClients) client.write(`event: stream.close\ndata: {}\n\n`);
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error("body too large"), { code: "E_VALIDATION" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { code: "E_VALIDATION" }));
      }
    });
    req.on("error", reject);
  });
}

export type { EventBus };
