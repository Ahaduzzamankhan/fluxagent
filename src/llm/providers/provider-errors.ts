/**
 * FluxAgent — provider error normalization (Phase 1).
 *
 * Every vendor speaks a different error dialect. This module maps vendor
 * HTTP responses and transport failures into the FluxAgent error taxonomy
 * so the router/recovery layers can classify and retry uniformly.
 *
 * Security rules enforced here:
 *   - API keys are NEVER included in error messages, details, or hints.
 *   - Provider messages are length-capped before embedding.
 *   - Response headers are not echoed (may contain request ids — fine —
 *     but authorization headers must never appear).
 */

import { FluxError, type FluxErrorCode } from "../../utils/errors.ts";

/** Normalized provider failure kinds (Phase 1 taxonomy). */
export type ProviderErrorKind =
  | "AUTHENTICATION_FAILED"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "MODEL_NOT_FOUND"
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "CONTENT_POLICY"
  | "UNKNOWN_PROVIDER_ERROR";

const KIND_TO_CODE: Readonly<Record<ProviderErrorKind, FluxErrorCode>> = {
  AUTHENTICATION_FAILED: "E_LLM_AUTH_FAILED",
  RATE_LIMITED: "E_LLM_RATE_LIMITED",
  INVALID_REQUEST: "E_LLM_RESPONSE_INVALID",
  MODEL_NOT_FOUND: "E_LLM_MODEL_NOT_FOUND",
  PROVIDER_UNAVAILABLE: "E_LLM_UNAVAILABLE",
  TIMEOUT: "E_LLM_TIMEOUT",
  NETWORK_ERROR: "E_LLM_NETWORK",
  CONTENT_POLICY: "E_LLM_CONTENT_POLICY",
  UNKNOWN_PROVIDER_ERROR: "E_LLM_PROVIDER_ERROR",
};

export class ProviderError extends FluxError {
  /** Normalized kind — stable across vendors. */
  readonly kind: ProviderErrorKind;
  /** HTTP status, when the failure came from an HTTP response. */
  readonly status?: number;
  /** Retry-After hint in ms when the provider supplied one. */
  readonly retryAfterMs?: number;
  /** Whether the router should retry this failure on another model. */
  readonly retryable: boolean;

  constructor(options: {
    kind: ProviderErrorKind;
    message: string;
    provider: string;
    status?: number;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    const code = KIND_TO_CODE[options.kind];
    const retryable =
      options.kind === "RATE_LIMITED" ||
      options.kind === "TIMEOUT" ||
      options.kind === "NETWORK_ERROR" ||
      options.kind === "PROVIDER_UNAVAILABLE";
    super({
      code,
      message: `[${options.provider}] ${options.message}`.slice(0, 500),
      details: {
        provider: options.provider,
        kind: options.kind,
        ...(options.status !== undefined ? { status: options.status } : {}),
      },
      cause: options.cause,
    });
    this.name = "ProviderError";
    this.kind = options.kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = retryable;
  }
}

/** Cap embedded provider messages (they may echo request content). */
function cap(message: unknown, max = 300): string {
  const s = typeof message === "string" ? message : safeJson(message);
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return String(v);
  }
}

/** Extract the best human-readable message from an unknown vendor body. */
function extractVendorMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    // OpenAI: { error: { message } }; Anthropic: { error: { message } };
    // Ollama: { error: "..." }; Google: { error: { message } }.
    const err = b.error;
    if (typeof err === "string") return cap(err);
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      if (typeof e.message === "string") return cap(e.message);
    }
    if (typeof b.message === "string") return cap(b.message);
    if (typeof b.detail === "string") return cap(b.detail);
  }
  return "unrecognized provider error body";
}

const STATUS_MAP: Readonly<Record<number, ProviderErrorKind>> = {
  400: "INVALID_REQUEST",
  401: "AUTHENTICATION_FAILED",
  403: "AUTHENTICATION_FAILED",
  404: "MODEL_NOT_FOUND",
  408: "TIMEOUT",
  413: "INVALID_REQUEST",
  422: "INVALID_REQUEST",
  429: "RATE_LIMITED",
  500: "PROVIDER_UNAVAILABLE",
  502: "PROVIDER_UNAVAILABLE",
  503: "PROVIDER_UNAVAILABLE",
  504: "TIMEOUT",
};

/** Some vendors use 400 for content policy; detect by message. */
function looksLikeContentPolicy(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("content policy") ||
    m.includes("content_filter") ||
    m.includes("content filtering") ||
    m.includes("safety") && m.includes("violation") ||
    m.includes("flagged")
  );
}

/**
 * Map an HTTP failure response to a ProviderError.
 * `body` may be parsed JSON or raw text; keys never contain secrets.
 */
export function providerHttpError(options: {
  provider: string;
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string | string[] | undefined>>;
}): ProviderError {
  const message = extractVendorMessage(options.body);
  let kind: ProviderErrorKind = STATUS_MAP[options.status] ?? "UNKNOWN_PROVIDER_ERROR";
  if (kind === "INVALID_REQUEST" && looksLikeContentPolicy(message)) kind = "CONTENT_POLICY";
  const retryAfterHeader = options.headers?.["retry-after"];
  const retryAfterSeconds =
    typeof retryAfterHeader === "string" ? Number(retryAfterHeader) : Array.isArray(retryAfterHeader) ? Number(retryAfterHeader[0]) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.round(retryAfterSeconds * 1000) : undefined;
  return new ProviderError({
    provider: options.provider,
    kind,
    message,
    status: options.status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

/** Map a transport-level failure (socket refused, DNS, abort) to a ProviderError. */
export function providerTransportError(options: {
  provider: string;
  error: unknown;
  timedOut: boolean;
}): ProviderError {
  if (options.timedOut) {
    return new ProviderError({
      provider: options.provider,
      kind: "TIMEOUT",
      message: "request timed out",
      cause: options.error,
    });
  }
  const err = options.error;
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  // AbortError from a caller's signal is surfaced as cancellation upstream;
  // here a deadline abort has already been mapped to TIMEOUT.
  if (name === "AbortError") {
    return new ProviderError({
      provider: options.provider,
      kind: "TIMEOUT",
      message: "request aborted",
      cause: err,
    });
  }
  return new ProviderError({
    provider: options.provider,
    kind: "NETWORK_ERROR",
    message: cap(msg),
    cause: err,
  });
}

/** Wrap an unparsable/malformed success response body. */
export function providerResponseError(options: {
  provider: string;
  message: string;
  cause?: unknown;
}): ProviderError {
  return new ProviderError({
    provider: options.provider,
    kind: "UNKNOWN_PROVIDER_ERROR",
    message: options.message,
    cause: options.cause,
  });
}
