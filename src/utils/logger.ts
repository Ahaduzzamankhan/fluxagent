/**
 * FluxAgent — structured logging.
 *
 * Log records: timestamp, level, component, message, metadata (+ correlation
 * bindings via `withBindings`). Secret redaction is applied recursively to
 * metadata before output. No global mutable state: loggers are constructed
 * with a sink; use `jsonSink`/`fileSink`/`consoleSink` factories as needed.
 */

import { createWriteStream } from "node:fs";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

export interface LogRecord {
  readonly timestamp: string; // ISO 8601
  readonly level: Exclude<LogLevel, "silent">;
  readonly component: string;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  readonly component: string;
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly redactKeys?: readonly string[];
}

const DEFAULT_REDACT_KEYS = [
  "apikey",
  "api_key",
  "authorization",
  "password",
  "passwd",
  "token",
  "secret",
  "credential",
  "cookie",
  "sessionid",
  "session_id",
] as const;

export class Logger {
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly redactKeys: ReadonlySet<string>;

  constructor(options: LoggerOptions) {
    this.level = options.level ?? "info";
    this.sink = options.sink ?? defaultConsoleSink;
    this.redactKeys = new Set(
      (options.redactKeys ?? DEFAULT_REDACT_KEYS).map((k) => k.toLowerCase()),
    );
  }

  child(component: string): Logger {
    return new Logger({
      component: `${this.component}.${component}`,
      level: this.level,
      sink: this.sink,
      redactKeys: [...this.redactKeys],
    });
  }

  isLevelEnabled(level: Exclude<LogLevel, "silent">): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.level];
  }

  trace(message: string, metadata?: Record<string, unknown>): void {
    this.write("trace", message, metadata);
  }
  debug(message: string, metadata?: Record<string, unknown>): void {
    this.write("debug", message, metadata);
  }
  info(message: string, metadata?: Record<string, unknown>): void {
    this.write("info", message, metadata);
  }
  warn(message: string, metadata?: Record<string, unknown>): void {
    this.write("warn", message, metadata);
  }
  error(message: string, metadata?: Record<string, unknown>): void {
    this.write("error", message, metadata);
  }
  fatal(message: string, metadata?: Record<string, unknown>): void {
    this.write("fatal", message, metadata);
  }

  /**
   * Derive a logger that injects correlation ids (requestId, taskId,
   * sessionId, pluginId, toolId, …) into every record. Values still pass
   * through redaction like any other metadata.
   */
  withBindings(bindings: Readonly<Record<string, unknown>>): Logger {
    const child = new Logger({
      component: this.component,
      level: this.level,
      sink: this.sink,
      redactKeys: [...this.redactKeys],
    });
    child.bindings = { ...this.bindings, ...bindings };
    return child;
  }

  private bindings: Readonly<Record<string, unknown>> = {};

  private write(
    level: Exclude<LogLevel, "silent">,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (!this.isLevelEnabled(level)) return;
    const hasBindings = Object.keys(this.bindings).length > 0;
    const merged = hasBindings || metadata
      ? { ...this.bindings, ...(metadata ?? {}) }
      : undefined;
    this.sink({
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      metadata: merged ? (redact(merged, this.redactKeys) as Record<string, unknown>) : undefined,
    });
  }
}

function defaultConsoleSink(record: LogRecord): void {
  const meta = record.metadata ? ` ${safeJson(record.metadata)}` : "";
  const line = `${record.timestamp} [${record.level.toUpperCase()}] [${record.component}] ${record.message}${meta}`;
  if (record.level === "error" || record.level === "fatal") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
}

/** One JSON object per line (machine-parseable; ships to log aggregators). */
export function jsonSink(): LogSink {
  return (record) => {
    console.log(JSON.stringify(record));
  };
}

/** Append-only file sink; opens the stream lazily on first record. */
export function fileSink(filePath: string): LogSink {
  let stream: import("node:fs").WriteStream | null = null;
  return (record) => {
    try {
      stream ??= createWriteStream(filePath, { flags: "a" });
      stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Logging must never crash the runtime; drop the record silently.
    }
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Recursive redaction; returns a copy, never mutates the input. */
export function redact(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): unknown {
  if (depth > 8) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((v) => redact(v, keys, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keys.has(k.toLowerCase()) ? "[REDACTED]" : redact(v, keys, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 10_000) {
    return `${value.slice(0, 10_000)}...[truncated ${value.length - 10_000} chars]`;
  }
  return value;
}
