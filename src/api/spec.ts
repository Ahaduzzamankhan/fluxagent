/**
 * FluxAgent — machine-readable API documentation (Phase 9.5).
 *
 * The route inventory is the single source of truth shared by the server and
 * the docs: `apiSpec()` emits a JSON description (version, endpoints, auth,
 * schemas) and `toOpenApi()` converts it into an OpenAPI 3.1 document that
 * existing tooling can render. Versioning: breaking changes bump API_VERSION
 * (and the path prefix); additive fields are non-breaking.
 */

export const API_SPEC_VERSION = "1.0.0";
export const API_PATH_PREFIX = "/api/v1";

export interface EndpointSpec {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string; // with {param} placeholders
  readonly summary: string;
  readonly scope?: string;
  readonly requestSchema?: Record<string, { type: string; required?: boolean; description?: string }>;
  readonly responseSchema?: Record<string, { type: string; description?: string }>;
  readonly errors: readonly { status: number; code: string }[];
}

export interface ApiSpec {
  readonly name: string;
  readonly apiVersion: string;
  readonly specVersion: string;
  readonly auth: readonly { kind: string; header: string }[];
  readonly endpoints: readonly EndpointSpec[];
  readonly streaming: {
    readonly protocol: "sse";
    readonly path: string;
    readonly eventTypes: readonly string[];
    readonly reconnect: string;
  };
}

const ENDPOINTS: readonly EndpointSpec[] = [
  {
    method: "GET", path: `${API_PATH_PREFIX}/health`, summary: "Liveness + basic runtime counters",
    errors: [],
    responseSchema: { status: { type: "string" }, version: { type: "string" }, uptimeMs: { type: "number" }, sessions: { type: "number" }, activeRuns: { type: "number" }, models: { type: "number" }, tools: { type: "number" } },
  },
  {
    method: "GET", path: `${API_PATH_PREFIX}/tools`, summary: "Registered tools (name, schema, permission level)",
    scope: "tools:read", errors: [{ status: 401, code: "E_PERMISSION_DENIED" }],
    responseSchema: { tools: { type: "array", description: "ToolInfo descriptors" } },
  },
  {
    method: "GET", path: `${API_PATH_PREFIX}/models`, summary: "Registered models with health + capabilities",
    scope: "tools:read", errors: [],
    responseSchema: { models: { type: "array", description: "ModelInfo with health snapshot" } },
  },
  {
    method: "POST", path: `${API_PATH_PREFIX}/agent/run`, summary: "Run a goal to completion (blocking)",
    scope: "agent:run",
    requestSchema: { goal: { type: "string", required: true }, sessionId: { type: "string", description: "reuse an existing session" } },
    responseSchema: { sessionId: { type: "string" }, result: { type: "object", description: "AgentRunResult" } },
    errors: [{ status: 400, code: "E_VALIDATION" }, { status: 401, code: "E_PERMISSION_DENIED" }, { status: 429, code: "E_SESSION_ALREADY_RUNNING" }],
  },
  {
    method: "GET", path: `${API_PATH_PREFIX}/agent/stream`, summary: "SSE stream of live agent events (optional sessionId filter, since= timestamp)",
    scope: "agent:run", errors: [{ status: 401, code: "E_PERMISSION_DENIED" }],
    responseSchema: { stream: { type: "string", description: "text/event-stream of AgentEvent payloads" } },
  },
  {
    method: "GET", path: `${API_PATH_PREFIX}/events`, summary: "Recent recorded events (since, limit)",
    scope: "events:read", errors: [],
    responseSchema: { events: { type: "array", description: "AgentEvent records" } },
  },
  {
    method: "GET", path: `${API_PATH_PREFIX}/sessions`, summary: "List sessions",
    scope: "sessions:read", errors: [],
    responseSchema: { sessions: { type: "array" } },
  },
  {
    method: "GET", path: `${API_PATH_PREFIX}/sessions/{id}`, summary: "Full serializable session state",
    scope: "sessions:read", errors: [{ status: 404, code: "E_SESSION_NOT_FOUND" }],
    responseSchema: { session: { type: "object", description: "AgentState" } },
  },
  {
    method: "GET", path: `${API_PATH_PREFIX}/tasks`, summary: "Task ledger (orchestrator state)",
    scope: "tasks:read", errors: [],
    responseSchema: { tasks: { type: "array" } },
  },
  {
    method: "GET", path: `${API_PATH_PREFIX}/tasks/{id}`, summary: "Single task with status/dependencies",
    scope: "tasks:read", errors: [{ status: 404, code: "E_VALIDATION" }],
    responseSchema: { task: { type: "object" } },
  },
];

export function apiSpec(): ApiSpec {
  return {
    name: "FluxAgent API",
    apiVersion: "v1",
    specVersion: API_SPEC_VERSION,
    auth: [
      { kind: "api-key", header: "Authorization: Bearer <key> or X-Api-Key" },
      { kind: "local", header: "loopback connections (no header)" },
    ],
    endpoints: ENDPOINTS,
    streaming: {
      protocol: "sse",
      path: `${API_PATH_PREFIX}/agent/stream`,
      eventTypes: [
        "agent.started", "agent.thinking", "agent.decided", "plan.created", "plan.updated",
        "step.started", "step.completed", "step.failed", "tool.called", "tool.completed",
        "tool.failed", "permission.requested", "permission.granted", "permission.denied",
        "agent.verified", "agent.recovered", "agent.completed", "agent.failed",
        "checkpoint.saved", "checkpoint.restored", "stream.open", "stream.close",
      ],
      reconnect: "clients SHOULD reconnect with exponential backoff; use since= to resume from the last seen timestamp",
    },
  };
}

/** Convert the spec to an OpenAPI 3.1 document for external tooling. */
export function toOpenApi(spec: ApiSpec = apiSpec()): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of spec.endpoints) {
    const openApiPath = e.path.replace(/\{(\w+)\}/g, "{$1}");
    paths[openApiPath] ??= {};
    paths[openApiPath][e.method.toLowerCase()] = {
      summary: e.summary,
      security: e.scope ? [{ bearerAuth: [] }] : [],
      ...(e.requestSchema ? { requestBody: { content: { "application/json": { schema: objectSchema(e.requestSchema) } } } } : {}),
      responses: {
        "200": { description: "success", content: { "application/json": { schema: e.responseSchema ? objectSchema(e.responseSchema) : undefined } } },
        ...Object.fromEntries(e.errors.map((err) => [err.status, { description: err.code }])),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: spec.name, version: spec.specVersion, description: `API version ${spec.apiVersion}` },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    paths,
    "x-flux-streaming": spec.streaming,
  };
}

function objectSchema(fields: Record<string, { type: string; required?: boolean; description?: string }>): Record<string, unknown> {
  const required = Object.entries(fields).filter(([, v]) => v.required).map(([k]) => k);
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { type: v.type, description: v.description }])),
    ...(required.length > 0 ? { required } : {}),
  };
}
