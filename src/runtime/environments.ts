/**
 * FluxAgent — production configuration (Phase 13.6).
 *
 * Environment presets (development / test / production) layered over
 * RuntimeConfig, with STARTUP VALIDATION: misconfiguration (permissive
 * security in production, missing limits, permissive logging) fails loudly
 * before the runtime accepts work.
 */

import { FluxError } from "../utils/errors.ts";
import { validateUntrustedInput } from "../security/audit.ts";
import type { RuntimeConfig } from "./config.ts";

export type Environment = "development" | "test" | "production";

export interface EnvConfig {
  readonly environment: Environment;
  readonly api: {
    readonly enabled: boolean;
    readonly port: number;
    readonly host: string;
    readonly authRequired: boolean;
  };
  readonly resources: {
    readonly maxConcurrentTasks: number;
    readonly maxQueueSize: number;
    readonly maxModelCallsPerMinute: number;
    readonly maxToolCallsPerMinute: number;
    readonly maxHeapMb?: number;
  };
  readonly cache: {
    readonly modelMetadataTtlMs: number;
    readonly toolMetadataTtlMs: number;
    readonly maxEntries: number;
  };
  readonly plugins: {
    readonly enabled: boolean;
    readonly directory?: string;
  };
  readonly observability: {
    readonly metricsEnabled: boolean;
    readonly healthCheckIntervalMs: number;
  };
}

export const ENV_PRESETS: Readonly<Record<Environment, EnvConfig>> = {
  development: {
    environment: "development",
    api: { enabled: true, port: 5800, host: "127.0.0.1", authRequired: false },
    resources: { maxConcurrentTasks: 4, maxQueueSize: 100, maxModelCallsPerMinute: 120, maxToolCallsPerMinute: 600 },
    cache: { modelMetadataTtlMs: 60_000, toolMetadataTtlMs: 60_000, maxEntries: 128 },
    plugins: { enabled: true, directory: "plugins" },
    observability: { metricsEnabled: true, healthCheckIntervalMs: 30_000 },
  },
  test: {
    environment: "test",
    api: { enabled: false, port: 0, host: "127.0.0.1", authRequired: true },
    resources: { maxConcurrentTasks: 2, maxQueueSize: 50, maxModelCallsPerMinute: 1000, maxToolCallsPerMinute: 1000 },
    cache: { modelMetadataTtlMs: 1_000, toolMetadataTtlMs: 1_000, maxEntries: 32 },
    plugins: { enabled: false },
    observability: { metricsEnabled: false, healthCheckIntervalMs: 5_000 },
  },
  production: {
    environment: "production",
    api: { enabled: true, port: 5800, host: "127.0.0.1", authRequired: true },
    resources: { maxConcurrentTasks: 8, maxQueueSize: 200, maxModelCallsPerMinute: 60, maxToolCallsPerMinute: 300, maxHeapMb: 2_048 },
    cache: { modelMetadataTtlMs: 300_000, toolMetadataTtlMs: 300_000, maxEntries: 256 },
    plugins: { enabled: true, directory: "plugins" },
    observability: { metricsEnabled: true, healthCheckIntervalMs: 15_000 },
  },
};

/** Resolve the env config for an environment name (or FLUX_ENV). */
export function resolveEnvConfig(environment?: string): EnvConfig {
  const name = (environment ?? process.env["FLUX_ENV"] ?? "development") as Environment;
  const preset = ENV_PRESETS[name];
  if (!preset) {
    throw new FluxError({
      code: "E_CONFIG_INVALID",
      message: `unknown environment "${name}" (expected development | test | production)`,
    });
  }
  return preset;
}

export interface ConfigValidationIssue {
  readonly path: string;
  readonly problem: string;
}

/**
 * Validate runtime + env config at startup. Production gets the strictest
 * rules: auth required, no auto-approve, no permissive logging, sandbox
 * roots must be explicit.
 */
export function validateStartupConfig(runtime: RuntimeConfig, env: EnvConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const prod = env.environment === "production";

  // JSON-serialize-ability + plain-object shape of the config itself (10.6).
  const plain = validateUntrustedInput(JSON.parse(JSON.stringify({ runtime, env })), { maxDepth: 8 });
  if (!plain.ok) issues.push({ path: "<config>", problem: plain.reason! });

  if (env.api.enabled && env.api.authRequired && !prod && env.api.host !== "127.0.0.1") {
    issues.push({ path: "api.host", problem: "auth-required API should bind to loopback in non-production" });
  }
  if (prod && !env.api.authRequired) {
    issues.push({ path: "api.authRequired", problem: "production requires API authentication" });
  }
  if (prod && runtime.security.mode === "auto-approve") {
    issues.push({ path: "security.mode", problem: "auto-approve is forbidden in production" });
  }
  if (prod && runtime.security.mode === "ask" && runtime.security.approvalTimeoutMs === 0) {
    issues.push({ path: "security.approvalTimeoutMs", problem: "ask-mode in production needs a finite approval timeout" });
  }
  if (prod && runtime.logging.level === "debug") {
    issues.push({ path: "logging.level", problem: "debug logging in production may leak sensitive content" });
  }
  if (prod && (runtime.security.allowedRoots.length === 0)) {
    issues.push({ path: "security.allowedRoots", problem: "production must declare explicit allowed filesystem roots" });
  }
  if (runtime.runtime.maxSteps <= 0 || runtime.runtime.maxSteps > 5_000) {
    issues.push({ path: "runtime.maxSteps", problem: "maxSteps must be in 1..5000" });
  }
  if (env.resources.maxConcurrentTasks <= 0) {
    issues.push({ path: "resources.maxConcurrentTasks", problem: "must be > 0" });
  }
  if (env.cache.maxEntries <= 0) {
    issues.push({ path: "cache.maxEntries", problem: "must be > 0" });
  }
  return issues;
}

/** Throw a structured error when startup validation fails. */
export function requireValidConfig(runtime: RuntimeConfig, env: EnvConfig): void {
  const issues = validateStartupConfig(runtime, env);
  if (issues.length > 0) {
    throw new FluxError({
      code: "E_CONFIG_INVALID",
      message: `startup config invalid (${issues.length} issue(s))`,
      details: { issues },
      hint: issues.map((i) => `${i.path}: ${i.problem}`).join("; "),
    });
  }
}
