/**
 * Phase 14 tests: platform adapters, config migrations, error
 * standardization, logging polish (bindings/sinks).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizePlatform,
  sandboxDefaults,
  canonicalPathFor,
  platformFacts,
} from "../../src/platform/platform.ts";
import {
  defaultSandboxPolicy,
  checkPathAllowed,
  SandboxViolationError,
} from "../../src/security/sandbox.ts";
import {
  migrateRawConfig,
  detectConfigVersion,
  CONFIG_VERSION,
} from "../../src/runtime/migrations.ts";
import { loadConfig, describeConfig } from "../../src/runtime/config.ts";
import { publicErrorJSON, categorizeError, isRetryableCode, FluxError } from "../../src/utils/errors.ts";
import { Logger, jsonSink } from "../../src/utils/logger.ts";

// ─── platform layer ──────────────────────────────────────────────────────────

test("platform: normalizePlatform maps hosts to the three targets", () => {
  assert.equal(normalizePlatform("win32"), "windows");
  assert.equal(normalizePlatform("darwin"), "macos");
  assert.equal(normalizePlatform("linux"), "linux");
  assert.equal(normalizePlatform("freebsd"), "linux");
});

test("platform: sandbox defaults differ per OS and deny OS-critical dirs", () => {
  const win = sandboxDefaults("windows");
  assert.ok(win.deniedRoots.some((r) => r.toLowerCase().startsWith("c:\\")));
  assert.ok(win.blockedCommandTokens.includes("bcdedit"));

  const linux = sandboxDefaults("linux");
  assert.ok(linux.deniedRoots.includes("/boot"));
  assert.ok(linux.blockedCommandTokens.includes("mkfs"));

  const mac = sandboxDefaults("macos");
  assert.ok(mac.deniedRoots.includes("/System"));
  assert.ok(mac.blockedCommandTokens.includes("csrutil disable"));
});

test("platform: canonicalPathFor handles Windows case-insensitivity and POSIX case-sensitivity", () => {
  assert.equal(canonicalPathFor("C:/Foo/Bar", "windows"), canonicalPathFor("c:\\foo\\bar", "windows"));
  assert.notEqual(canonicalPathFor("/USR", "linux"), canonicalPathFor("/usr", "linux"));
  assert.equal(canonicalPathFor("/usr/local/", "linux"), "/usr/local");
});

test("platform: platformFacts resolve shell and temp dir per platform", () => {
  const win = platformFacts("win32", {});
  assert.equal(win.isWindows, true);
  assert.equal(win.shellName, "cmd.exe");
  assert.equal(win.tempDir, "C:\\Temp");

  const linux = platformFacts("linux", { TMPDIR: "/custom-tmp" });
  assert.equal(linux.isWindows, false);
  assert.equal(linux.tempDir, "/custom-tmp");
});

test("platform: sandbox guard blocks POSIX-critical dirs on POSIX hosts", () => {
  const policy = defaultSandboxPolicy("linux");
  assert.throws(() => checkPathAllowed("/boot/vmlinuz", policy), SandboxViolationError);
  // And the Windows policy still blocks its own roots:
  const winPolicy = defaultSandboxPolicy("windows");
  assert.throws(() => checkPathAllowed("C:\\Windows\\system32\\config", winPolicy), SandboxViolationError);
});

// ─── config migrations ───────────────────────────────────────────────────────

test("migrations: v0 nested memory shape is flattened and obsolete keys dropped", () => {
  const v0 = {
    runtime: { maxSteps: 40, maxStepsWithoutProgress: 8, defaultWorkingDirectory: "." },
    security: { mode: "ask", defaultPermissionLevel: "USER_CONFIRMATION", maxCommandsPerMinute: 20 },
    memory: {
      shortTerm: { maxMessages: 200 },
      longTerm: { backend: "json-file", directory: ".data/mem" },
    },
    logging: { level: "info", destination: "console" },
  };
  const result = migrateRawConfig(v0);
  assert.equal(result.migrated["configVersion"], CONFIG_VERSION);
  const memory = result.migrated["memory"] as Record<string, unknown>;
  assert.equal(memory["longTermDirectory"], ".data/mem");
  assert.equal(memory["longTerm"], undefined);
  assert.equal(memory["shortTerm"], undefined);
  assert.ok(result.droppedKeys.includes("runtime.maxStepsWithoutProgress"));
  assert.ok(result.droppedKeys.includes("security.defaultPermissionLevel"));
  assert.ok(result.droppedKeys.includes("logging.destination"));
  assert.ok(result.appliedMigrations.length >= 1);
});

test("migrations: idempotent on already-current configs and respects explicit version", () => {
  const v1 = { configVersion: 1, memory: { longTermDirectory: "x" } };
  const result = migrateRawConfig(v1);
  assert.deepEqual(result.appliedMigrations, []);
  assert.equal(detectConfigVersion(v1), 1);
  assert.equal(detectConfigVersion({}), 0);
});

test("migrations: future versions pass through untouched", () => {
  const future = { configVersion: 99, whatever: true };
  const result = migrateRawConfig(future);
  assert.equal(result.migrated["configVersion"], 99);
  assert.deepEqual(result.appliedMigrations, []);
});

test("loadConfig: reads the legacy v0 default.json shape via migration", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flux-cfg-"));
  const file = path.join(dir, "old.json");
  await fs.writeFile(file, JSON.stringify({
    memory: { longTerm: { backend: "json-file", directory: "legacy/mem" } },
    runtime: { maxSteps: 33, maxStepsWithoutProgress: 5 },
  }));
  const config = await loadConfig(file);
  assert.equal(config.memory.longTermDirectory, "legacy/mem");
  assert.equal(config.runtime.maxSteps, 33);
});

// ─── error standardization ───────────────────────────────────────────────────

test("errors: publicErrorJSON exposes category/retryability without stack traces", () => {
  const err = new FluxError({ code: "E_LLM_RATE_LIMITED", message: "slow down", hint: "backoff", details: { model: "m" } });
  const pub = publicErrorJSON(err);
  assert.equal(pub.error.code, "E_LLM_RATE_LIMITED");
  assert.equal(pub.error.category, "model");
  assert.equal(pub.error.retryable, true);
  assert.equal(pub.error.hint, "backoff");
  const serialized = JSON.stringify(pub);
  assert.ok(!serialized.includes("at "), "no stack trace in public shape");

  // Details are opt-in.
  assert.equal(publicErrorJSON(err).error.details, undefined);
  assert.deepEqual(publicErrorJSON(err, { includeDetails: true }).error.details, { model: "m" });

  // Unknown errors are internal + not retryable.
  const unknown = publicErrorJSON(new Error("boom"));
  assert.equal(unknown.error.category, "internal");
  assert.equal(unknown.error.retryable, false);
});

test("errors: categorizeError and isRetryableCode cover the code map", () => {
  assert.equal(categorizeError(new FluxError({ code: "E_SANDBOX_VIOLATION", message: "x" })), "sandbox");
  assert.equal(categorizeError(new FluxError({ code: "E_CONFIG_INVALID", message: "x" })), "configuration");
  assert.equal(categorizeError("string error"), "internal");
  assert.equal(isRetryableCode("E_STEP_TIMEOUT"), true);
  assert.equal(isRetryableCode("E_SANDBOX_VIOLATION"), false);
});

// ─── logging polish ──────────────────────────────────────────────────────────

test("logger: withBindings injects correlation ids and redacts secret-like bindings", () => {
  const records: unknown[] = [];
  const base = new Logger({ component: "test", level: "trace", sink: (r) => records.push(r) });
  base.fatal("fatal works");
  const bound = base.withBindings({ requestId: "r-1", traceId: "tr-42", apiKey: "sk-123" });
  bound.info("hello", { toolId: "t-1" });
  const fatal = records[0] as { level: string };
  const info = records[1] as { metadata: Record<string, unknown> };
  assert.equal(fatal.level, "fatal");
  assert.equal(info.metadata["requestId"], "r-1");
  assert.equal(info.metadata["traceId"], "tr-42");
  assert.equal(info.metadata["apiKey"], "[REDACTED]");
  assert.equal(info.metadata["toolId"], "t-1");
});

test("logger: jsonSink emits one JSON object per record", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => lines.push(String(line));
  try {
    const sink = jsonSink();
    sink({ timestamp: "t", level: "info", component: "c", message: "m" });
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!) as { level: string; message: string };
  assert.equal(parsed.level, "info");
  assert.equal(parsed.message, "m");
});

// ─── config diagnostics ──────────────────────────────────────────────────────

test("describeConfig: never echoes providerOptions values", () => {
  const described = describeConfig({
    runtime: { maxSteps: 10, stepTimeoutMs: 1000 },
    planning: { maxPlanSteps: 5, allowReplanning: false },
    llm: { provider: "openai", providerOptions: { apiKey: "sk-super-secret" } },
    security: { mode: "ask", ceiling: "SAFE_WRITE", allowedRoots: [], deniedRoots: [], blockedCommandTokens: [], approvalTimeoutMs: 0 },
    memory: { longTermDirectory: "m" },
    python: { enabled: false, interpreter: "python", workerScript: "w", timeoutMs: 1 },
    logging: { level: "info", redactKeys: [] },
  });
  const text = JSON.stringify(described);
  assert.ok(!text.includes("sk-super-secret"), "secret value must not appear");
  assert.deepEqual((described.llm as { providerOptions: { keys: string[] } }).providerOptions.keys, ["apiKey"]);
});
