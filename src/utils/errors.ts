/**
 * FluxAgent — typed error hierarchy.
 *
 * Every intentional runtime error derives from `FluxError`, carries a
 * machine-readable `code`, an optional user-facing hint, and structured
 * details. `isFluxError` is the single safe way to discriminate.
 */

export type FluxErrorCode =
  // validation / input
  | "E_VALIDATION"
  | "E_SCHEMA_MISMATCH"
  // tools
  | "E_TOOL_NOT_FOUND"
  | "E_TOOL_ALREADY_REGISTERED"
  | "E_TOOL_ARGUMENTS_INVALID"
  | "E_TOOL_EXECUTION"
  // permissions / security
  | "E_PERMISSION_DENIED"
  | "E_PERMISSION_LEVEL_EXCEEDED"
  | "E_APPROVAL_REJECTED"
  | "E_APPROVAL_TIMEOUT"
  // agents / runtime
  | "E_AGENT_STATE"
  | "E_STEP_NOT_FOUND"
  | "E_DEPENDENCY_NOT_SATISFIED"
  | "E_PLAN_INVALID"
  | "E_MAX_STEPS"
  | "E_STEP_TIMEOUT"
  | "E_RECOVERY_EXHAUSTED"
  | "E_SESSION_NOT_FOUND"
  | "E_SESSION_ALREADY_RUNNING"
  | "E_CONFIG_INVALID"
  // sandbox / command policy
  | "E_SANDBOX_VIOLATION"
  | "E_COMMAND_BLOCKED"
  // llm
  | "E_LLM_UNAVAILABLE"
  | "E_LLM_RESPONSE_INVALID"
  | "E_LLM_RATE_LIMITED"
  | "E_LLM_PROVIDER_ERROR"
  // memory
  | "E_MEMORY_KEY_NOT_FOUND"
  | "E_MEMORY_BACKEND"
  // python bridge
  | "E_PYTHON_BRIDGE"
  | "E_PYTHON_MODULE_NOT_FOUND"
  // platform
  | "E_PLATFORM_UNSUPPORTED"
  // cancellations
  | "E_CANCELLED"
  // generic fallback
  | "E_INTERNAL";

export interface FluxErrorOptions {
  readonly code: FluxErrorCode;
  readonly message: string;
  /** Short, actionable hint suitable for the agent to reason about recovery. */
  readonly hint?: string;
  /** Non-sensitive structured details for logs/state. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class FluxError extends Error {
  readonly code: FluxErrorCode;
  readonly hint?: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(options: FluxErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.hint = options.hint;
    this.details = options.details ?? {};
  }

  toJSON(): FluxErrorJSON {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      hint: this.hint,
      details: this.details,
    };
  }
}

export interface FluxErrorJSON {
  readonly name: string;
  readonly code: FluxErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly details: Readonly<Record<string, unknown>>;
}

// ─── Error categories (Phase 14 standardization) ────────────────────────────

/**
 * Coarse category for routing/monitoring — every `FluxErrorCode` maps to
 * exactly one. Categories are stable; codes may be added within a category.
 */
export type ErrorCategory =
  | "configuration" | "model" | "tool" | "permission" | "validation"
  | "network" | "storage" | "plugin" | "task" | "sandbox"
  | "timeout" | "cancelled" | "platform" | "internal";

const CATEGORY_BY_CODE: Readonly<Record<FluxErrorCode, ErrorCategory>> = {
  E_VALIDATION: "validation",
  E_SCHEMA_MISMATCH: "validation",
  E_TOOL_NOT_FOUND: "tool",
  E_TOOL_ALREADY_REGISTERED: "tool",
  E_TOOL_ARGUMENTS_INVALID: "validation",
  E_TOOL_EXECUTION: "tool",
  E_PERMISSION_DENIED: "permission",
  E_PERMISSION_LEVEL_EXCEEDED: "permission",
  E_APPROVAL_REJECTED: "permission",
  E_APPROVAL_TIMEOUT: "permission",
  E_AGENT_STATE: "task",
  E_STEP_NOT_FOUND: "task",
  E_DEPENDENCY_NOT_SATISFIED: "task",
  E_PLAN_INVALID: "task",
  E_MAX_STEPS: "task",
  E_STEP_TIMEOUT: "timeout",
  E_RECOVERY_EXHAUSTED: "task",
  E_SESSION_NOT_FOUND: "task",
  E_SESSION_ALREADY_RUNNING: "task",
  E_CONFIG_INVALID: "configuration",
  E_SANDBOX_VIOLATION: "sandbox",
  E_COMMAND_BLOCKED: "sandbox",
  E_LLM_UNAVAILABLE: "model",
  E_LLM_RESPONSE_INVALID: "model",
  E_LLM_RATE_LIMITED: "model",
  E_LLM_PROVIDER_ERROR: "model",
  E_MEMORY_KEY_NOT_FOUND: "storage",
  E_MEMORY_BACKEND: "storage",
  E_PYTHON_BRIDGE: "internal",
  E_PYTHON_MODULE_NOT_FOUND: "internal",
  E_PLATFORM_UNSUPPORTED: "platform",
  E_CANCELLED: "cancelled",
  E_INTERNAL: "internal",
};

/** Coarse category of an error code (stable for monitoring/routing). */
export function errorCategory(code: FluxErrorCode): ErrorCategory {
  return CATEGORY_BY_CODE[code];
}

/** Category of any thrown value; non-Flux errors map to "internal". */
export function categorizeError(e: unknown): ErrorCategory {
  return isFluxError(e) ? CATEGORY_BY_CODE[e.code] : "internal";
}

const RETRYABLE_CODES: ReadonlySet<FluxErrorCode> = new Set<FluxErrorCode>([
  "E_LLM_UNAVAILABLE",
  "E_LLM_RATE_LIMITED",
  "E_LLM_PROVIDER_ERROR",
  "E_STEP_TIMEOUT",
  "E_MEMORY_BACKEND",
  "E_PYTHON_BRIDGE",
]);

/** Whether retrying the same operation could plausibly succeed. */
export function isRetryableCode(code: FluxErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/**
 * Public-safe error shape: code, category, retryable, message, hint —
 * deliberately WITHOUT stack traces or raw details. HTTP/SDK responses use
 * this; `details` are only included when explicitly requested (dev mode).
 */
export function publicErrorJSON(e: unknown, options: { includeDetails?: boolean } = {}): {
  error: {
    code: FluxErrorCode | "E_INTERNAL";
    category: ErrorCategory;
    retryable: boolean;
    message: string;
    hint?: string;
    details?: Readonly<Record<string, unknown>>;
  };
} {
  const flux = toFluxError(e);
  return {
    error: {
      code: flux.code,
      category: CATEGORY_BY_CODE[flux.code],
      retryable: RETRYABLE_CODES.has(flux.code),
      message: flux.message,
      ...(flux.hint !== undefined ? { hint: flux.hint } : {}),
      ...(options.includeDetails && Object.keys(flux.details).length > 0 ? { details: flux.details } : {}),
    },
  };
}

/** Typed subclasses for common construction sites. */
export class ValidationError extends FluxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "E_VALIDATION", message, details });
  }
}

export class ToolNotFoundError extends FluxError {
  constructor(toolName: string, available: readonly string[]) {
    super({
      code: "E_TOOL_NOT_FOUND",
      message: `Tool not registered: "${toolName}"`,
      hint: `Available tools: ${available.slice(0, 12).join(", ") || "(none)"}`,
      details: { toolName },
    });
  }
}

export class ToolArgumentsInvalidError extends FluxError {
  constructor(toolName: string, issues: readonly string[]) {
    super({
      code: "E_TOOL_ARGUMENTS_INVALID",
      message: `Invalid arguments for tool "${toolName}"`,
      hint: issues.join("; "),
      details: { toolName, issues },
    });
  }
}

export class PermissionDeniedError extends FluxError {
  constructor(
    permission: string,
    subject: string,
    reason: string,
  ) {
    super({
      code: "E_PERMISSION_DENIED",
      message: `Permission "${permission}" denied for ${subject}: ${reason}`,
      details: { permission, subject, reason },
    });
  }
}

export class ApprovalRejectedError extends FluxError {
  constructor(action: string) {
    super({
      code: "E_APPROVAL_REJECTED",
      message: `User rejected approval for: ${action}`,
      details: { action },
    });
  }
}

export class ApprovalTimeoutError extends FluxError {
  constructor(action: string, timeoutMs: number) {
    super({
      code: "E_APPROVAL_TIMEOUT",
      message: `Approval for "${action}" timed out after ${timeoutMs}ms`,
      details: { action, timeoutMs },
    });
  }
}

export class CancelledError extends FluxError {
  constructor(what: string) {
    super({ code: "E_CANCELLED", message: `Cancelled: ${what}` });
  }
}

export class SandboxViolationError extends FluxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "E_SANDBOX_VIOLATION", message, details });
  }
}

/** Raised when an expected file/directory is missing. */
export class FileNotFoundError extends FluxError {
  constructor(path: string) {
    super({ code: "E_INTERNAL", message: `File not found: ${path}` });
  }
}

export class CommandBlockedError extends FluxError {
  constructor(command: string, args: readonly string[], reason: string) {
    super({
      code: "E_COMMAND_BLOCKED",
      message: `Command blocked by policy: ${command} ${args.join(" ")}`.trim(),
      hint: reason,
      details: { command, args },
    });
  }
}

export class PlatformUnsupportedError extends FluxError {
  constructor(operation: string, platform: string) {
    super({
      code: "E_PLATFORM_UNSUPPORTED",
      message: `Operation "${operation}" is unsupported on platform "${platform}"`,
      hint: "FluxAgent is Windows-first; this operation requires a Windows host (or a future platform adapter).",
      details: { operation, platform },
    });
  }
}

export class PythonBridgeError extends FluxError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super({ code: "E_PYTHON_BRIDGE", message, details, cause });
  }
}

/** Type guard: true when `e` is a FluxError from this runtime. */
export function isFluxError(e: unknown): e is FluxError {
  return e instanceof FluxError;
}

/** Normalize any thrown value into a FluxError without losing information. */
export function toFluxError(e: unknown, fallbackMessage = "Unknown error"): FluxError {
  if (isFluxError(e)) return e;
  if (e instanceof Error) {
    return new FluxError({ code: "E_INTERNAL", message: e.message, cause: e });
  }
  return new FluxError({
    code: "E_INTERNAL",
    message: typeof e === "string" ? e : fallbackMessage,
    details: { raw: String(e) },
  });
}
