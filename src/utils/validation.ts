/**
 * FluxAgent — tiny dependency-free validation helpers.
 *
 * Deliberately minimal: produces human-readable issue lists rather than
 * throwing, so tools can aggregate issues before failing.
 */

import { ValidationError } from "./errors.ts";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function assertRecord(v: unknown, what = "value"): asserts v is Record<string, unknown> {
  if (!isRecord(v)) throw new ValidationError(`${what} must be an object`);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function assertNonEmptyString(v: unknown, what = "value"): asserts v is string {
  if (!isNonEmptyString(v)) throw new ValidationError(`${what} must be a non-empty string`);
}

export function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

export function assertEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
  what = "value",
): asserts v is T {
  if (!allowed.includes(v as T)) {
    throw new ValidationError(`${what} must be one of: ${allowed.join(", ")}`);
  }
}

/** Normalize a Windows-friendly path-ish string (no FS access). */
export function normalizeSlashes(p: string): string {
  return p.replace(/\//g, "\\");
}

export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
    return Object.freeze(obj);
  }
  return obj;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[truncated ${s.length - max}]`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });
}
