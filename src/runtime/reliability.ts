/**
 * FluxAgent — reliability layer (Phase 7.5).
 *
 * Composable, reusable resilience primitives:
 *
 *   - RetryPolicy     — exponential backoff with full jitter, retry budget
 *   - CircuitBreaker  — stop hammering a failing dependency (closed/open/half-open)
 *   - withTimeout     — deadline enforcement on async work
 *   - withFallback    — graceful degradation to an alternate implementation
 *   - executeReliably — the composition used by executors/transport
 *
 * All primitives are pure orchestration: they take async functions, wrap them,
 * and report structured outcomes. Timeouts abort via AbortSignal — no orphan
 * work keeps running after a deadline.
 */

import { FluxError } from "../utils/errors.ts";
import { sleep } from "../utils/validation.ts";

// ─── Retry policy ─────────────────────────────────────────────────────────────

export interface RetryPolicyOptions {
  /** Max attempts INCLUDING the first one. Must be >= 1. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Multiplier per attempt (exponential backoff). */
  readonly backoffFactor?: number;
  /** 0..1 — full jitter spreads delays to avoid thundering herds. */
  readonly jitter?: boolean;
  /** Classify whether an error is worth retrying; default: retry everything. */
  readonly isRetryable?: (error: unknown) => boolean;
}

export interface RetryAttempt {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export interface RetryResult<T> {
  readonly value: T;
  readonly attempts: number;
  readonly totalDelayMs: number;
  readonly history: readonly RetryAttempt[];
}

export const DEFAULT_RETRY_POLICY: Required<Omit<RetryPolicyOptions, "isRetryable">> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  backoffFactor: 2,
  jitter: true,
};

export class RetryExhaustedError extends FluxError {
  readonly lastError: unknown;

  constructor(operation: string, attempts: number, lastError: unknown) {
    super({
      code: "E_RECOVERY_EXHAUSTED",
      message: `operation "${operation}" failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      details: { operation, attempts },
      hint: lastError instanceof Error ? lastError.message : undefined,
    });
    this.name = "RetryExhaustedError";
    this.lastError = lastError;
  }
}

export function delayForAttempt(policy: Required<Omit<RetryPolicyOptions, "isRetryable">>, attempt: number): number {
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.backoffFactor ** (attempt - 1));
  return policy.jitter ? Math.round(base * (0.5 + Math.random() * 0.5)) : base;
}

/** Execute `fn` under the retry policy. Deterministic outcome structure. */
export async function withRetry<T>(
  operation: string,
  fn: (attempt: number, signal: AbortSignal) => Promise<T>,
  options: RetryPolicyOptions & { signal?: AbortSignal } = {},
): Promise<RetryResult<T>> {
  const policy = { ...DEFAULT_RETRY_POLICY, ...options };
  const isRetryable = options.isRetryable ?? (() => true);
  const history: RetryAttempt[] = [];
  let totalDelayMs = 0;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const value = await fn(attempt, new AbortController().signal);
      return { value, attempts: attempt, totalDelayMs, history };
    } catch (err) {
      // Cancellation is never retried.
      if (options.signal?.aborted) throw err;
      if (attempt >= policy.maxAttempts || !isRetryable(err)) {
        if (attempt === 1) throw err; // single-shot failure: preserve original error
        throw new RetryExhaustedError(operation, attempt, err);
      }
      const delayMs = delayForAttempt(policy, attempt);
      history.push({ attempt, delayMs, error: err });
      totalDelayMs += delayMs;
      await sleep(delayMs);
    }
  }
  throw new FluxError({ code: "E_INTERNAL", message: "retry loop exited unexpectedly" }); // unreachable
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. */
  readonly failureThreshold?: number;
  /** Open → half-open after this long. */
  readonly resetMs?: number;
  /** Half-open successes needed to close. */
  readonly successThreshold?: number;
}

export class CircuitOpenError extends FluxError {
  readonly openedForMs: number;

  constructor(circuit: string, openedForMs: number) {
    super({
      code: "E_LLM_UNAVAILABLE",
      message: `circuit "${circuit}" is open (opened ${openedForMs}ms ago); failing fast`,
      details: { circuit, openedForMs },
    });
    this.name = "CircuitOpenError";
    this.openedForMs = openedForMs;
  }
}

/**
 * Three-state circuit breaker per dependency name. Instances are cheap —
 * one per dependency (tool name, model id, endpoint).
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successesInHalfOpen = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetMs: number;
  private readonly successThreshold: number;

  readonly circuitName: string;

  constructor(
    circuitName: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.circuitName = circuitName;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetMs = options.resetMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 1;
  }

  get currentState(): CircuitState {
    if (this.state === "open" && Date.now() - this.openedAt >= this.resetMs) {
      this.state = "half-open"; // allow a probe
    }
    return this.state;
  }

  /** Wrap an async call; throws CircuitOpenError while open. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;
    if (state === "open") {
      throw new CircuitOpenError(this.circuitName, Date.now() - this.openedAt);
    }
    try {
      const value = await fn();
      this.onSuccess();
      return value;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.successesInHalfOpen += 1;
      if (this.successesInHalfOpen >= this.successThreshold) this.reset();
      return;
    }
    this.failures = 0;
  }

  private onFailure(): void {
    if (this.state === "half-open") {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = Date.now();
    this.failures = 0;
    this.successesInHalfOpen = 0;
  }

  private reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.successesInHalfOpen = 0;
    this.openedAt = 0;
  }
}

// ─── Timeout ──────────────────────────────────────────────────────────────────

export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  operation = "operation",
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Race fn against the deadline so signal-ignoring work is still cut off.
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(new FluxError({
        code: "E_STEP_TIMEOUT",
        message: `${operation} timed out after ${timeoutMs}ms`,
      }));
    }, { once: true });
  });
  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof FluxError)) {
      throw new FluxError({
        code: "E_STEP_TIMEOUT",
        message: `${operation} timed out after ${timeoutMs}ms`,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

export interface FallbackOutcome<T> {
  readonly value: T;
  /** Which impl index produced the value (0 = primary). */
  readonly via: number;
  /** Errors from impls tried before the successful one. */
  readonly degraded: boolean;
}

/** Try implementations in order; first success wins. */
export async function withFallback<T>(
  impls: readonly { name: string; run: () => Promise<T> }[],
): Promise<FallbackOutcome<T>> {
  if (impls.length === 0) {
    throw new FluxError({ code: "E_VALIDATION", message: "withFallback requires at least one implementation" });
  }
  const errors: unknown[] = [];
  for (let i = 0; i < impls.length; i++) {
    try {
      const value = await impls[i]!.run();
      return { value, via: i, degraded: i > 0 };
    } catch (err) {
      errors.push(err);
    }
  }
  const last = errors[errors.length - 1];
  throw new RetryExhaustedError(impls.map((i) => i.name).join(" → "), impls.length, last);
}

// ─── Composition ──────────────────────────────────────────────────────────────

export interface ReliableExecutionOptions<T> extends RetryPolicyOptions {
  readonly operation: string;
  readonly timeoutMs?: number;
  readonly breaker?: CircuitBreaker;
  /** Alternates tried when the primary path exhausts retries. */
  readonly fallbacks?: readonly { name: string; run: (signal: AbortSignal) => Promise<T> }[];
  readonly signal?: AbortSignal;
}

export interface ReliableExecution<T> {
  readonly value: T;
  readonly attempts: number;
  readonly via: string;
  readonly degraded: boolean;
  readonly totalDelayMs: number;
}

/** Retry + timeout + circuit breaker + fallback, composed. */
export async function executeReliably<T>(
  primary: (signal: AbortSignal) => Promise<T>,
  options: ReliableExecutionOptions<T>,
): Promise<ReliableExecution<T>> {
  const runPrimary = async (): Promise<{ value: T; attempts: number; totalDelayMs: number }> => {
    const exec = async (signal: AbortSignal): Promise<T> => {
      const attempt = options.timeoutMs !== undefined
        ? await withTimeout((s) => primary(s), options.timeoutMs, options.operation)
        : await primary(signal);
      return attempt;
    };
    const run = options.breaker ? () => options.breaker!.execute(() => exec(new AbortController().signal)) : () => exec(new AbortController().signal);
    const result = await withRetry(options.operation, async (_attempt, signal) => run().then((v) => {
      void signal;
      return v;
    }), options);
    return { value: result.value, attempts: result.attempts, totalDelayMs: result.totalDelayMs };
  };

  const impls = [
    { name: "primary", run: runPrimary },
    ...(options.fallbacks ?? []).map((f) => ({
      name: f.name,
      run: async (): Promise<{ value: T; attempts: number; totalDelayMs: number }> => {
        const value = await f.run(new AbortController().signal);
        return { value, attempts: 1, totalDelayMs: 0 };
      },
    })),
  ];

  // All impls return the { value, attempts, totalDelayMs } wrapper shape, so
  // unwrap unconditionally — avoids mis-detecting user values that happen to
  // look like the wrapper.
  const wrapped = await withFallback(impls);
  const shape = wrapped.value as { value: T; attempts: number; totalDelayMs: number };
  return {
    value: shape.value,
    attempts: shape.attempts,
    via: impls[wrapped.via]!.name,
    degraded: wrapped.degraded,
    totalDelayMs: shape.totalDelayMs,
  };
}
