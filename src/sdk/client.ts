/**
 * FluxAgent — TypeScript client SDK (Phase 9).
 *
 * A thin, strongly-typed client over the universal HTTP API. Works from
 * Node, browsers, desktop shells, and CLIs — anywhere `fetch` and
 * `EventSource` (or the provided SSE fallback) exist. No core dependencies.
 *
 *   const client = new FluxAgentClient({ baseUrl: "http://127.0.0.1:5800" });
 *   const health = await client.health();
 *   const result = await client.runAgent({ goal: "…" });
 *   const off = client.on("step.completed", (e) => console.log(e.stepId));
 *   for await (const event of client.stream("goal text")) { … }
 *
 * Streaming (9.3): SSE consumption with automatic reconnect + exponential
 * backoff, Last-Event-ID style resume via `since` timestamps, and graceful
 * disconnect.
 */

import type { AgentEvent, AgentEventType } from "../events/events.ts";

export interface FluxAgentClientOptions {
  readonly baseUrl: string;
  /** API key, sent as `Authorization: Bearer <key>` when set. */
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  /** Reconnect tuning for the streaming client. */
  readonly reconnectMaxAttempts?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly logger?: { debug?: (m: string, m2?: unknown) => void; warn?: (m: string, m2?: unknown) => void };
}

export interface HealthReport {
  readonly status: string;
  readonly version: string;
  readonly uptimeMs: number;
  readonly sessions: number;
  readonly activeRuns: number;
  readonly models: number;
  readonly tools: number;
}

export interface ToolInfoDTO {
  readonly name: string;
  readonly description: string;
  readonly permissionLevel: string;
  readonly inputSchema: unknown;
  readonly tags: readonly string[];
}

export interface ModelInfoDTO {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly quality: number;
  readonly cost: number;
  readonly healthy: boolean;
  readonly health: { failures: number; successes: number; latencyMsAvg: number | null };
}

export interface RunResultDTO {
  readonly sessionId: string;
  readonly result: {
    readonly status: "completed" | "failed" | "cancelled";
    readonly summary: string;
    readonly stepsCompleted: number;
    readonly stepsFailed: number;
    readonly durationMs: number;
  };
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

export class FluxAgentApiError extends Error {
  readonly status: number;
  readonly apiError: ApiError;

  constructor(status: number, apiError: ApiError) {
    super(`API ${status}: ${apiError.code}: ${apiError.message}`);
    this.name = "FluxAgentApiError";
    this.status = status;
    this.apiError = apiError;
  }
}

type AgentEventHandler = (event: AgentEvent) => void;

export class FluxAgentClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly handlers = new Map<string, Set<AgentEventHandler>>();
  private readonly reconnectMaxAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly logger?: FluxAgentClientOptions["logger"];
  private lastEventTimestamp: string | null = null;
  private abortController: AbortController | null = null;

  constructor(options: FluxAgentClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.reconnectMaxAttempts = options.reconnectMaxAttempts ?? 5;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 500;
    this.logger = options.logger;
  }

  // ── request plumbing ───────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (payload.error as ApiError | undefined) ?? { code: "E_UNKNOWN", message: res.statusText };
      throw new FluxAgentApiError(res.status, err);
    }
    return payload as T;
  }

  // ── core endpoints ─────────────────────────────────────────────────────────

  health(): Promise<HealthReport> {
    return this.request("GET", "/health");
  }

  listTools(): Promise<readonly ToolInfoDTO[]> {
    return this.request<{ tools: readonly ToolInfoDTO[] }>("GET", "/tools").then((r) => r.tools);
  }

  listModels(): Promise<readonly ModelInfoDTO[]> {
    return this.request<{ models: readonly ModelInfoDTO[] }>("GET", "/models").then((r) => r.models);
  }

  runAgent(input: { goal: string; sessionId?: string }): Promise<RunResultDTO> {
    return this.request("POST", "/agent/run", input);
  }

  listSessions(): Promise<readonly { id: string; goal: string }[]> {
    return this.request<{ sessions: readonly { id: string; goal: string }[] }>("GET", "/sessions").then((r) => r.sessions);
  }

  getSession(id: string): Promise<unknown> {
    return this.request("GET", `/sessions/${encodeURIComponent(id)}`);
  }

  listTasks(): Promise<readonly { id: string; goal: string; status: string; priority: string }[]> {
    return this.request<{ tasks: readonly { id: string; goal: string; status: string; priority: string }[] }>("GET", "/tasks").then((r) => r.tasks);
  }

  recentEvents(limit = 100): Promise<readonly AgentEvent[]> {
    return this.request<{ events: readonly AgentEvent[] }>("GET", `/events?limit=${limit}`).then((r) => r.events);
  }

  // ── typed event subscription (9.2) ─────────────────────────────────────────

  /**
   * Subscribe to events received by any active streaming connection or the
   * event buffer. Returns an unsubscribe function.
   */
  on<T extends AgentEventType>(type: T, handler: (event: Extract<AgentEvent, { type: T }>) => void): () => void {
    return this.onPattern(type, handler as AgentEventHandler);
  }

  onAny(handler: AgentEventHandler): () => void {
    return this.onPattern("*", handler);
  }

  private onPattern(pattern: string, handler: AgentEventHandler): () => void {
    const set = this.handlers.get(pattern) ?? new Set<AgentEventHandler>();
    set.add(handler);
    this.handlers.set(pattern, set);
    return () => set.delete(handler);
  }

  private dispatch(event: AgentEvent): void {
    if (event.timestamp > (this.lastEventTimestamp ?? "")) this.lastEventTimestamp = event.timestamp;
    for (const [pattern, set] of this.handlers) {
      if (pattern === "*" || event.type === pattern || (pattern.endsWith("*") && event.type.startsWith(pattern.slice(0, -1)))) {
        for (const h of [...set]) {
          try {
            h(event);
          } catch (err) {
            this.logger?.warn?.("event handler failed", err);
          }
        }
      }
    }
  }

  // ── streaming (9.3) ────────────────────────────────────────────────────────

  /**
   * Stream live events for a goal run. Yields parsed AgentEvent objects;
   * dispatches them to `on()` subscribers as well. Reconnects automatically
   * with exponential backoff until the run completes or the consumer breaks.
   */
  async *stream(goal: string, options: { sessionId?: string } = {}): AsyncGenerator<AgentEvent> {
    this.abortController = new AbortController();
    let attempt = 0;
    const params = new URLSearchParams({ goal });
    if (options.sessionId) params.set("sessionId", options.sessionId);
    if (this.lastEventTimestamp) params.set("since", this.lastEventTimestamp);

    while (attempt <= this.reconnectMaxAttempts) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/agent/stream?${params}`, {
          headers: this.headers(),
          signal: this.abortController.signal,
        });
        if (!res.ok || !res.body) {
          throw new FluxAgentApiError(res.status, { code: "E_STREAM", message: `stream status ${res.status}` });
        }
        attempt = 0; // connected — reset backoff
        for await (const payload of parseSse(res.body)) {
          if (payload.event === "stream.close") return;
          if (payload.event === "stream.open" || !payload.data) continue;
          try {
            const event = JSON.parse(payload.data) as AgentEvent;
            this.dispatch(event);
            yield event;
          } catch {
            this.logger?.warn?.("unparseable stream event", payload);
          }
        }
        return; // server closed cleanly
      } catch (err) {
        if (this.abortController.signal.aborted) return;
        attempt++;
        if (attempt > this.reconnectMaxAttempts) {
          throw new FluxAgentApiError(503, {
            code: "E_STREAM",
            message: `stream failed after ${this.reconnectMaxAttempts} reconnect attempts: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        const delay = this.reconnectBaseDelayMs * 2 ** (attempt - 1);
        this.logger?.warn?.(`stream reconnect in ${delay}ms (attempt ${attempt})`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** Disconnect the active stream gracefully. */
  disconnect(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

interface SsePayload {
  readonly event: string;
  readonly data?: string;
}

/** Minimal SSE parser over a byte stream (no EventSource dependency). */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SsePayload> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let data = "";
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          else if (line.startsWith("data: ")) data += line.slice(6);
          else if (line.startsWith("data:")) data += line.slice(5);
        }
        if (eventName || data) yield { event: eventName, data: data || undefined };
        eventName = "";
        data = "";
      }
    }
  } finally {
    reader.releaseLock();
  }
}
