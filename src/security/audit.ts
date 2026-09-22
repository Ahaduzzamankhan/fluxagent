/**
 * FluxAgent — audit logging (Phase 10.5) + input validation (Phase 10.6).
 *
 * AuditLog records security-relevant events (permission requested/granted/
 * denied, tool executed, process started/finished, auth failures) as
 * structured, append-only records with retention bounds. Values that look
 * sensitive (args previews, headers) are redacted before storage.
 *
 * Validators treat model-generated instructions and API payloads as
 * UNTRUSTED input: shape-checked, size-bounded, no nested surprises.
 */

import { randomBytes } from "node:crypto";
import type { Logger } from "../utils/logger.ts";

// ─── Audit log ────────────────────────────────────────────────────────────────

export type AuditEventType =
  | "auth.success"
  | "auth.failure"
  | "permission.requested"
  | "permission.granted"
  | "permission.denied"
  | "tool.executed"
  | "tool.rejected"
  | "process.started"
  | "process.finished"
  | "file.deleted"
  | "command.executed"
  | "config.changed"
  | "secret.accessed";

export interface AuditRecord {
  readonly id: string;
  readonly at: string;
  readonly type: AuditEventType;
  readonly actor: string; // principal id or "system"
  readonly subject: string; // tool/process/permission name
  readonly outcome: "allowed" | "denied" | "completed" | "failed";
  readonly detail: Readonly<Record<string, unknown>>;
  /** Correlation: session/run/task ids for tracing. */
  readonly sessionId?: string;
  readonly runId?: string;
  readonly taskId?: string;
}

export interface AuditLogOptions {
  readonly logger?: Logger;
  /** Max in-memory records (bounded; hook `onRecord` to persist). */
  readonly maxRecords?: number;
  readonly onRecord?: (record: AuditRecord) => void;
  readonly redactKeys?: readonly string[];
}

const DEFAULT_REDACT = ["apikey", "api_key", "authorization", "password", "token", "secret", "credential", "cookie"];

export class AuditLog {
  private readonly records: AuditRecord[] = [];
  private readonly maxRecords: number;
  private readonly redactKeys: ReadonlySet<string>;
  private readonly logger?: Logger;
  private readonly onRecord?: (record: AuditRecord) => void;

  constructor(options: AuditLogOptions = {}) {
    this.maxRecords = options.maxRecords ?? 5_000;
    this.redactKeys = new Set([...(options.redactKeys ?? DEFAULT_REDACT)].map((k) => k.toLowerCase()));
    this.logger = options.logger;
    this.onRecord = options.onRecord;
  }

  record(input: {
    type: AuditEventType;
    actor?: string;
    subject: string;
    outcome: AuditRecord["outcome"];
    detail?: Record<string, unknown>;
    sessionId?: string;
    runId?: string;
    taskId?: string;
  }): AuditRecord {
    const rec: AuditRecord = {
      id: `aud_${randomBytes(8).toString("hex")}`,
      at: new Date().toISOString(),
      type: input.type,
      actor: input.actor ?? "system",
      subject: input.subject,
      outcome: input.outcome,
      detail: redact(input.detail ?? {}, this.redactKeys),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    this.records.push(rec);
    if (this.records.length > this.maxRecords) this.records.shift();
    this.onRecord?.(rec);
    this.logger?.debug("audit", { type: rec.type, subject: rec.subject, outcome: rec.outcome });
    return rec;
  }

  query(filter: { type?: AuditEventType; actor?: string; sessionId?: string; since?: string; limit?: number } = {}): readonly AuditRecord[] {
    let out = this.records;
    if (filter.type) out = out.filter((r) => r.type === filter.type);
    if (filter.actor) out = out.filter((r) => r.actor === filter.actor);
    if (filter.sessionId) out = out.filter((r) => r.sessionId === filter.sessionId);
    if (filter.since) out = out.filter((r) => r.at > filter.since!);
    const limit = filter.limit ?? (this.maxRecords >= out.length ? out.length : this.maxRecords);
    return out.slice(-limit);
  }

  get size(): number {
    return this.records.length;
  }
}

function redact(value: unknown, keys: ReadonlySet<string>): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = keys.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

// ─── Input validation (untrusted input) ───────────────────────────────────────

export interface ValidationLimits {
  readonly maxStringLength?: number;
  readonly maxDepth?: number;
  readonly maxKeys?: number;
  readonly maxArrayLength?: number;
}

export const DEFAULT_VALIDATION_LIMITS: Required<ValidationLimits> = {
  maxStringLength: 10_000,
  maxDepth: 8,
  maxKeys: 100,
  maxArrayLength: 1_000,
};

export interface UntrustedValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Validate an untrusted value: plain JSON types only, size-bounded strings,
 * depth-bounded objects, key-count-bounded maps. Rejects functions, symbols,
 * prototypes, and anything too large. Used for API payloads, tool arguments
 * from model output, and serialized task state.
 */
export function validateUntrustedInput(value: unknown, limits: ValidationLimits = {}): UntrustedValidationResult {
  const max = { ...DEFAULT_VALIDATION_LIMITS, ...limits };
  return check(value, max, 0);
}

function check(value: unknown, max: Required<ValidationLimits>, depth: number): UntrustedValidationResult {
  if (depth > max.maxDepth) return { ok: false, reason: `nesting exceeds ${max.maxDepth} levels` };
  if (value === null) return { ok: true };
  if (typeof value === "string") {
    return value.length <= max.maxStringLength ? { ok: true } : { ok: false, reason: `string exceeds ${max.maxStringLength} chars` };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true } : { ok: false, reason: "non-finite number" };
  }
  if (typeof value === "boolean") return { ok: true };
  if (Array.isArray(value)) {
    if (value.length > max.maxArrayLength) return { ok: false, reason: `array exceeds ${max.maxArrayLength} items` };
    for (const item of value) {
      const r = check(item, max, depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return { ok: false, reason: "non-plain object (prototype pollution guard)" };
    }
    const keys = Object.keys(value);
    if (keys.length > max.maxKeys) return { ok: false, reason: `object exceeds ${max.maxKeys} keys` };
    for (const k of keys) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        return { ok: false, reason: `forbidden key "${k}"` };
      }
      const r = check((value as Record<string, unknown>)[k], max, depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  return { ok: false, reason: `unsupported type: ${typeof value}` };
}

/** Validate a plugin manifest (Phase 12) — untrusted input, strict shape. */
export function validatePluginManifest(manifest: unknown): UntrustedValidationResult & { manifest?: PluginManifest } {
  const base = validateUntrustedInput(manifest, { maxDepth: 4, maxStringLength: 2_000 });
  if (!base.ok) return base;
  const m = manifest as Partial<PluginManifest>;
  if (typeof m.name !== "string" || !/^[a-z0-9][a-z0-9-_.]{0,63}$/.test(m.name)) {
    return { ok: false, reason: "manifest.name must match ^[a-z0-9][a-z0-9-_.]{1,63}$" };
  }
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+$/.test(m.version)) {
    return { ok: false, reason: "manifest.version must be semver (x.y.z)" };
  }
  if (m.apiVersion === undefined || typeof m.apiVersion !== "string") {
    return { ok: false, reason: "manifest.apiVersion is required" };
  }
  if (typeof m.contributes !== "object" || m.contributes === null) {
    return { ok: false, reason: "manifest.contributes must be an object" };
  }
  return { ok: true, manifest: m as PluginManifest };
}

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly description?: string;
  readonly author?: string;
  readonly permissions?: readonly string[]; // requested permission levels/scopes
  readonly contributes: {
    readonly tools?: readonly { name: string; description: string; permissionLevel: string; create: string }[];
    readonly eventHandlers?: readonly { pattern: string; create: string }[];
    readonly memoryProviders?: readonly { name: string; create: string }[];
    readonly modelProviders?: readonly { name: string; create: string }[];
  };
}
