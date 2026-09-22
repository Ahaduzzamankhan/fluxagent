/**
 * FluxAgent — runtime configuration.
 *
 * Loads config/default.json (or a user-specified file), merges env overrides,
 * and validates into typed sections. Secrets come from the environment only.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { FluxError } from "../utils/errors.ts";
import { isRecord } from "../utils/validation.ts";
import type { PermissionLevel } from "../tools/permissions.ts";
import { isPermissionLevel } from "../tools/permissions.ts";
import type { LogLevel } from "../utils/logger.ts";
import { sandboxDefaults } from "../platform/platform.ts";
import { migrateRawConfig } from "./migrations.ts";

export interface RuntimeConfig {
  readonly runtime: {
    readonly maxSteps: number;
    readonly stepTimeoutMs: number;
  };
  readonly planning: {
    readonly maxPlanSteps: number;
    readonly allowReplanning: boolean;
  };
  readonly llm: {
    readonly provider: string;
    readonly providerOptions: Readonly<Record<string, unknown>>;
  };
  readonly security: {
    readonly mode: "ask" | "auto-approve" | "deny-all";
    readonly ceiling: PermissionLevel;
    readonly allowedRoots: readonly string[];
    readonly deniedRoots: readonly string[];
    readonly blockedCommandTokens: readonly string[];
    readonly approvalTimeoutMs: number;
  };
  readonly memory: {
    readonly longTermDirectory: string;
  };
  readonly python: {
    readonly enabled: boolean;
    readonly interpreter: string;
    readonly workerScript: string;
    readonly timeoutMs: number;
  };
  readonly logging: {
    readonly level: LogLevel;
    readonly redactKeys: readonly string[];
  };
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  runtime: { maxSteps: 60, stepTimeoutMs: 60_000 },
  planning: { maxPlanSteps: 25, allowReplanning: true },
  llm: { provider: "mock", providerOptions: {} },
  security: {
    mode: "ask",
    ceiling: "PRIVILEGED",
    allowedRoots: [],
    deniedRoots: sandboxDefaults(process.platform).deniedRoots,
    blockedCommandTokens: [...sandboxDefaults(process.platform).blockedCommandTokens],
    approvalTimeoutMs: 0,
  },
  memory: { longTermDirectory: ".fluxagent/memory" },
  python: { enabled: false, interpreter: "python", workerScript: "python/worker.py", timeoutMs: 30_000 },
  logging: { level: "info", redactKeys: ["apiKey", "password", "token", "secret"] },
};

/** Load + migrate + validate a config file, merged over defaults. */
export async function loadConfig(file = path.join("config", "default.json")): Promise<RuntimeConfig> {
  let raw: unknown;
  try {
    const text = await fs.readFile(file, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw new FluxError({
      code: "E_CONFIG_INVALID",
      message: `failed to read config ${file}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!isRecord(raw)) {
    throw new FluxError({ code: "E_CONFIG_INVALID", message: "config root must be an object" });
  }
  // Old formats keep loading: run versioned migrations before merging.
  const { migrated } = migrateRawConfig(raw);
  return mergeConfig(DEFAULT_CONFIG, migrated);
}

function mergeConfig(base: RuntimeConfig, patch: Record<string, unknown>): RuntimeConfig {
  const out: RuntimeConfig = structuredClone(base) as RuntimeConfig;

  if (isRecord(patch.runtime)) {
    out.runtime = {
      maxSteps: num(patch.runtime.maxSteps, out.runtime.maxSteps),
      stepTimeoutMs: num(patch.runtime.stepTimeoutMs, out.runtime.stepTimeoutMs),
    };
  }
  if (isRecord(patch.planning)) {
    out.planning = {
      maxPlanSteps: num(patch.planning.maxPlanSteps, out.planning.maxPlanSteps),
      allowReplanning: bool(patch.planning.allowReplanning, out.planning.allowReplanning),
    };
  }
  if (isRecord(patch.llm)) {
    out.llm = {
      provider: str(patch.llm.provider, out.llm.provider),
      providerOptions: isRecord(patch.llm.providerOptions) ? patch.llm.providerOptions : out.llm.providerOptions,
    };
  }
  if (isRecord(patch.security)) {
    const sec = patch.security;
    out.security = {
      mode: str(sec.mode, out.security.mode) as RuntimeConfig["security"]["mode"],
      ceiling: isPermissionLevel(sec.ceiling) ? sec.ceiling : out.security.ceiling,
      allowedRoots: strs(sec.allowedRoots, out.security.allowedRoots),
      deniedRoots: strs(sec.deniedRoots, out.security.deniedRoots),
      blockedCommandTokens: strs(sec.blockedCommandTokens, out.security.blockedCommandTokens),
      approvalTimeoutMs: num(sec.approvalTimeoutMs, out.security.approvalTimeoutMs),
    };
  }
  if (isRecord(patch.memory)) {
    out.memory = { longTermDirectory: str(patch.memory.longTermDirectory, out.memory.longTermDirectory) };
  }
  if (isRecord(patch.python)) {
    out.python = {
      enabled: bool(patch.python.enabled, out.python.enabled),
      interpreter: str(patch.python.interpreter, out.python.interpreter),
      workerScript: str(patch.python.workerScript, out.python.workerScript),
      timeoutMs: num(patch.python.timeoutMs, out.python.timeoutMs),
    };
  }
  if (isRecord(patch.logging)) {
    out.logging = {
      level: str(patch.logging.level, out.logging.level) as LogLevel,
      redactKeys: strs(patch.logging.redactKeys, out.logging.redactKeys),
    };
  }
  return out;
}

/**
 * Configuration diagnostics — key/value shape only, safe to print.
 * Values that look like secrets are masked by name; nothing from
 * `providerOptions` is ever echoed (it may hold provider credentials).
 */
export function describeConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    runtime: config.runtime,
    planning: config.planning,
    llm: { provider: config.llm.provider, providerOptions: { keys: Object.keys(config.llm.providerOptions) } },
    security: {
      mode: config.security.mode,
      ceiling: config.security.ceiling,
      allowedRoots: config.security.allowedRoots,
      deniedRoots: config.security.deniedRoots,
      blockedCommandTokens: config.security.blockedCommandTokens,
      approvalTimeoutMs: config.security.approvalTimeoutMs,
    },
    memory: config.memory,
    python: config.python,
    logging: { level: config.logging.level, redactKeys: config.logging.redactKeys },
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
function strs(v: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [...fallback];
}
