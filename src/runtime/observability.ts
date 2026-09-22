/**
 * FluxAgent — observability & production runtime (Phase 13).
 *
 * 13.2 Cache        — TTL+LRU cache with namespace policies; only safe,
 *                     deterministic operations get cached (never secrets,
 *                     never user content unless the policy says so).
 * 13.3 Resources    — tracked gauges/limits: concurrent tasks, queue size,
 *                     model calls, tool calls, memory; acquire/release with
 *                     rejection over the limit.
 * 13.7 Observability— Metrics registry (counters, gauges, histograms with
 *                     bounded buckets), correlation ids, health checks that
 *                     aggregate subsystem status.
 * 13.5 Storage      — KeyValueStorage interface; InMemory + JSON-file
 *                     backends; databases plug in later.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

// ─── 13.2 Cache ───────────────────────────────────────────────────────────────

export interface CachePolicy {
  /** Entries live this long (ms). */
  readonly ttlMs: number;
  /** Max entries (LRU eviction). */
  readonly maxEntries: number;
  /** Namespace — also the invalidation key. */
  readonly namespace: string;
  /** Explicit flag: entries may contain sensitive values. Default false. */
  readonly mayContainSecrets?: boolean;
}

export const DEFAULT_CACHE_POLICY: CachePolicy = {
  ttlMs: 60_000,
  maxEntries: 256,
  namespace: "default",
  mayContainSecrets: false,
};

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly entries: number;
}

interface CacheEntry<V> {
  readonly value: V;
  readonly storedAt: number;
  readonly expiresAt: number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  private readonly policy: CachePolicy;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(policy: Partial<CachePolicy> = {}) {
    this.policy = { ...DEFAULT_CACHE_POLICY, ...policy };
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    // LRU touch.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (!this.policy.mayContainSecrets && looksLikeSecretKey(key)) {
      throw new Error(`cache "${this.policy.namespace}": refusing to cache key that looks like a secret ("${key}") without mayContainSecrets`);
    }
    if (this.entries.size >= this.policy.maxEntries) {
      // Evict the oldest (first inserted = least recently used after touch).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        this.evictions++;
      }
    }
    this.entries.set(key, { value, storedAt: Date.now(), expiresAt: Date.now() + this.policy.ttlMs });
  }

  /** Get-or-compute with single-flight dedupe per key. */
  private readonly inflight = new Map<string, Promise<V>>();
  async getOrCompute(key: string, compute: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = compute()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, evictions: this.evictions, entries: this.entries.size };
  }
}

function looksLikeSecretKey(key: string): boolean {
  return /secret|password|token|api[-_]?key|credential/i.test(key);
}

// ─── 13.3 Resource management ─────────────────────────────────────────────────

export interface ResourceLimits {
  readonly maxConcurrentTasks?: number;
  readonly maxQueueSize?: number;
  readonly maxModelCallsPerMinute?: number;
  readonly maxToolCallsPerMinute?: number;
  readonly maxHeapMb?: number;
}

export interface ResourceUsage {
  readonly concurrentTasks: number;
  readonly queueSize: number;
  readonly modelCallsLastMinute: number;
  readonly toolCallsLastMinute: number;
  readonly heapUsedMb: number;
}

export interface AcquireTicket {
  release(): void;
}

/** Tracks + enforces limits; rejection is structured, not a throw-and-forget. */
export class ResourceLimiter {
  private readonly limits: Required<Pick<ResourceLimits, "maxConcurrentTasks" | "maxQueueSize" | "maxModelCallsPerMinute" | "maxToolCallsPerMinute">>;
  private readonly maxHeapMb?: number;
  private concurrentTasks = 0;
  private queueSize = 0;
  private readonly modelCallTimes: number[] = [];
  private readonly toolCallTimes: number[] = [];

  constructor(limits: ResourceLimits = {}) {
    this.limits = {
      maxConcurrentTasks: limits.maxConcurrentTasks ?? 8,
      maxQueueSize: limits.maxQueueSize ?? 200,
      maxModelCallsPerMinute: limits.maxModelCallsPerMinute ?? 60,
      maxToolCallsPerMinute: limits.maxToolCallsPerMinute ?? 300,
    };
    this.maxHeapMb = limits.maxHeapMb;
  }

  tryAcquireTask(): AcquireTicket | null {
    this.prune();
    if (this.concurrentTasks >= this.limits.maxConcurrentTasks) return null;
    this.concurrentTasks++;
    return { release: () => { this.concurrentTasks = Math.max(0, this.concurrentTasks - 1); } };
  }

  tryEnqueue(): boolean {
    if (this.queueSize >= this.limits.maxQueueSize) return false;
    this.queueSize++;
    return true;
  }

  dequeue(): void {
    this.queueSize = Math.max(0, this.queueSize - 1);
  }

  recordModelCall(): boolean {
    this.prune();
    if (this.modelCallTimes.length >= this.limits.maxModelCallsPerMinute) return false;
    this.modelCallTimes.push(Date.now());
    return true;
  }

  recordToolCall(): boolean {
    this.prune();
    if (this.toolCallTimes.length >= this.limits.maxToolCallsPerMinute) return false;
    this.toolCallTimes.push(Date.now());
    return true;
  }

  usage(): ResourceUsage {
    this.prune();
    return {
      concurrentTasks: this.concurrentTasks,
      queueSize: this.queueSize,
      modelCallsLastMinute: this.modelCallTimes.length,
      toolCallsLastMinute: this.toolCallTimes.length,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
    };
  }

  overHeapLimit(): boolean {
    if (this.maxHeapMb === undefined) return false;
    return process.memoryUsage().heapUsed / (1024 * 1024) > this.maxHeapMb;
  }

  private prune(): void {
    const cutoff = Date.now() - 60_000;
    while (this.modelCallTimes.length > 0 && this.modelCallTimes[0]! < cutoff) this.modelCallTimes.shift();
    while (this.toolCallTimes.length > 0 && this.toolCallTimes[0]! < cutoff) this.toolCallTimes.shift();
  }
}

// ─── 13.7 Metrics + correlation ids ───────────────────────────────────────────

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly gauges: Readonly<Record<string, number>>;
  readonly histograms: Readonly<Record<string, { count: number; avg: number; p95: number; max: number }>>;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histogramValues = new Map<string, number[]>();
  private readonly maxHistogramSamples = 2_000;

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, value: number): void {
    let values = this.histogramValues.get(name);
    if (!values) {
      values = [];
      this.histogramValues.set(name, values);
    }
    values.push(value);
    if (values.length > this.maxHistogramSamples) values.shift();
  }

  snapshot(): MetricsSnapshot {
    const histograms: Record<string, { count: number; avg: number; p95: number; max: number }> = {};
    for (const [name, values] of this.histogramValues) {
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
      histograms[name] = {
        count: values.length,
        avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
        p95,
        max: sorted[sorted.length - 1]!,
      };
    }
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms,
    };
  }
}

/** Correlation ids: request → task → step chains. */
export function newCorrelationId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Health checks ────────────────────────────────────────────────────────────

export interface HealthCheckResult {
  readonly name: string;
  readonly healthy: boolean;
  readonly detail: string;
  readonly durationMs: number;
}

export interface HealthCheck {
  readonly name: string;
  check: () => Promise<{ healthy: boolean; detail: string }> | { healthy: boolean; detail: string };
}

export class HealthRegistry {
  private readonly checks = new Map<string, HealthCheck>();

  register(check: HealthCheck): () => void {
    this.checks.set(check.name, check);
    return () => this.checks.delete(check.name);
  }

  async evaluate(): Promise<{ healthy: boolean; checks: readonly HealthCheckResult[] }> {
    const results: HealthCheckResult[] = [];
    for (const check of this.checks.values()) {
      const startedAt = Date.now();
      try {
        const outcome = await check.check();
        results.push({ name: check.name, durationMs: Date.now() - startedAt, ...outcome });
      } catch (err) {
        results.push({
          name: check.name,
          healthy: false,
          detail: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        });
      }
    }
    return { healthy: results.every((r) => r.healthy), checks: results };
  }
}

// ─── 13.5 Storage abstraction ─────────────────────────────────────────────────

export interface KeyValueStorage {
  readonly name: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<readonly string[]>;
}

export class InMemoryStorage implements KeyValueStorage {
  readonly name = "memory";
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(prefix = ""): Promise<readonly string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** Each key becomes one JSON file in the directory (windows-safe names). */
export class JsonFileStorage implements KeyValueStorage {
  readonly name = "json-file";
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private fileFor(key: string): string {
    return path.join(this.directory, `${encodeURIComponent(key)}.json`);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.fileFor(key), "utf8");
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(this.fileFor(key), value, "utf8");
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.fileFor(key), { force: true });
  }

  async keys(prefix = ""): Promise<readonly string[]> {
    try {
      const files = await fs.readdir(this.directory);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => decodeURIComponent(f.slice(0, -5)))
        .filter((k) => k.startsWith(prefix));
    } catch {
      return [];
    }
  }
}
