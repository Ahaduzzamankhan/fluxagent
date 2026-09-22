/**
 * FluxAgent — error diagnosis.
 *
 * Structured error analysis: CLASSIFY → DIAGNOSE → RECOMMEND. The recovery
 * engine consumes `Diagnosis` to pick a strategy; nothing retries blindly.
 *
 * Category set: validation | permission | timeout | network | tool |
 * environment | state | dependency | cancelled | unknown.
 */

import type { FluxErrorJSON } from "../utils/errors.ts";
import type { Observation } from "../agent/state.ts";

export type ErrorCategory =
  | "validation"
  | "permission"
  | "timeout"
  | "network"
  | "tool"
  | "environment"
  | "state"
  | "dependency"
  | "cancelled"
  | "unknown";

export type RecoveryRecommendation =
  | "repair-args"
  | "request-approval"
  | "retry"
  | "retry-with-backoff"
  | "check-connectivity"
  | "select-alternative-tool"
  | "re-observe"
  | "satisfy-dependency"
  | "replan"
  | "abort"
  | "escalate-to-user";

export interface Diagnosis {
  readonly category: ErrorCategory;
  /** Root-cause summary, human readable. */
  readonly rootCause: string;
  readonly recommendation: RecoveryRecommendation;
  /** Can this class of failure reasonably be retried as-is? */
  readonly retryable: boolean;
  /** Is a retry likely to succeed, or is the problem structural? */
  readonly transient: boolean;
  /** Structured evidence extracted from the error. */
  readonly details: Readonly<Record<string, unknown>>;
}

/** FluxErrorCode → category map. Codes not listed default via heuristics. */
const CODE_CATEGORY: Readonly<Record<string, ErrorCategory>> = {
  E_VALIDATION: "validation",
  E_SCHEMA_MISMATCH: "validation",
  E_TOOL_ARGUMENTS_INVALID: "validation",
  E_PERMISSION_DENIED: "permission",
  E_PERMISSION_LEVEL_EXCEEDED: "permission",
  E_APPROVAL_REJECTED: "permission",
  E_APPROVAL_TIMEOUT: "permission",
  E_SANDBOX_VIOLATION: "permission",
  E_COMMAND_BLOCKED: "permission",
  E_STEP_TIMEOUT: "timeout",
  E_LLM_RATE_LIMITED: "network",
  E_LLM_UNAVAILABLE: "network",
  E_LLM_PROVIDER_ERROR: "network",
  E_TOOL_NOT_FOUND: "tool",
  E_TOOL_ALREADY_REGISTERED: "tool",
  E_TOOL_EXECUTION: "tool",
  E_PLATFORM_UNSUPPORTED: "environment",
  E_PYTHON_BRIDGE: "dependency",
  E_PYTHON_MODULE_NOT_FOUND: "dependency",
  E_DEPENDENCY_MISSING: "dependency",
  E_STEP_NOT_FOUND: "state",
  E_DEPENDENCY_NOT_SATISFIED: "state",
  E_AGENT_STATE: "state",
  E_CANCELLED: "cancelled",
  E_INTERNAL: "unknown",
};

/** Message-level heuristics for errors without a known code. */
const MESSAGE_PATTERNS: readonly { pattern: RegExp; category: ErrorCategory }[] = [
  { pattern: /\bnot found\b|\bENOENT\b|\bno such file/i, category: "state" },
  { pattern: /\btimeout\b|\btimed out\b|\bETIMEDOUT\b/i, category: "timeout" },
  { pattern: /\bnetwork\b|\bECONNREFUSED\b|\bconnection refused\b|\bfetch failed\b|\bENOTFOUND\b/i, category: "network" },
  { pattern: /\bpermission\b|\baccess is denied\b|\bEPERM\b|\bEACCES\b/i, category: "permission" },
  { pattern: /\bmissing\b|\bnot installed\b|\bmodule\b/i, category: "dependency" },
];

export function categorize(error: FluxErrorJSON | null | undefined): ErrorCategory {
  if (!error) return "unknown";
  const mapped = CODE_CATEGORY[error.code];
  if (mapped) return mapped;
  const message = `${error.message} ${error.hint ?? ""}`;
  for (const { pattern, category } of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return category;
  }
  return "unknown";
}

const RECOMMENDATION_BY_CATEGORY: Readonly<Record<ErrorCategory, RecoveryRecommendation>> = {
  validation: "repair-args",
  permission: "request-approval",
  timeout: "retry-with-backoff",
  network: "check-connectivity",
  tool: "select-alternative-tool",
  environment: "escalate-to-user",
  state: "re-observe",
  dependency: "satisfy-dependency",
  cancelled: "abort",
  unknown: "replan",
};

/** Is this category transient (worth an automatic retry)? */
const TRANSIENT_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  "timeout",
  "network",
]);

/**
 * Diagnose a failed observation into a structured Diagnosis.
 * Pure function — the RecoveryEngine decides how to act on it.
 */
export function diagnose(observation: Observation): Diagnosis {
  const category = categorize(observation.error);
  const rootCause = observation.error
    ? observation.error.message
    : observation.ok
      ? "no error recorded but verification failed"
      : "unknown failure";

  let recommendation = RECOMMENDATION_BY_CATEGORY[category];

  // Refinements beyond the coarse category.
  const message = observation.error?.message.toLowerCase() ?? "";
  if (category === "unknown" && /\bnot found\b/.test(message)) {
    recommendation = "re-observe";
  }
  if (observation.error?.code === "E_TOOL_NOT_FOUND") {
    recommendation = "select-alternative-tool";
  }

  return {
    category,
    rootCause,
    recommendation,
    retryable: category !== "cancelled" && category !== "permission",
    transient: TRANSIENT_CATEGORIES.has(category),
    details: {
      errorCode: observation.error?.code ?? null,
      toolName: observation.toolName,
      callId: observation.callId,
    },
  };
}

/** Quick check: does an error code correspond to a user-permission problem? */
export function isPermissionProblem(error: FluxErrorJSON | null | undefined): boolean {
  return categorize(error) === "permission";
}
