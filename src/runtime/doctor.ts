/**
 * FluxAgent — health diagnostics ("fluxagent doctor").
 *
 * Operational checks over the real subsystems: node, python, config load +
 * migration, storage round-trip, sandbox policy sanity, tool registry,
 * model router, python worker protocol. Every check returns PASS / WARN /
 * FAIL / SKIP with a short, secret-free detail string. Machine-readable via
 * `DoctorReport` (CLI renders it as JSON with --json).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { loadConfig, describeConfig, DEFAULT_CONFIG, type RuntimeConfig } from "./config.ts";
import { migrateRawConfig, CONFIG_VERSION } from "./migrations.ts";
import { defaultSandboxPolicy } from "../security/sandbox.ts";
import { platformFacts } from "../platform/platform.ts";
import { createRuntime, type FluxRuntime } from "./runtime.ts";
import { MockLlmProvider } from "../llm/mock-provider.ts";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly durationMs: number;
}

export interface DoctorReport {
  readonly healthy: boolean;
  readonly platform: ReturnType<typeof platformFacts>["key"];
  readonly nodeVersion: string;
  readonly checks: readonly DoctorCheck[];
  readonly configSummary: Record<string, unknown> | null;
}

export interface DoctorOptions {
  readonly configFile?: string;
  readonly cwd?: string;
  /** Skip the python worker check (e.g. when python is known-absent). */
  readonly skipPython?: boolean;
}

interface CheckOutcome {
  readonly status: CheckStatus;
  readonly detail: string;
}

function timed(name: string, fn: () => CheckOutcome | Promise<CheckOutcome>): Promise<DoctorCheck> {
  const startedAt = Date.now();
  return Promise.resolve()
    .then(fn)
    .then(
      (outcome): DoctorCheck => ({ name, status: outcome.status, detail: outcome.detail, durationMs: Date.now() - startedAt }),
      (err): DoctorCheck => ({
        name,
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      }),
    );
}

/** Run all doctor checks. Never throws; failures become FAIL entries. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const facts = platformFacts();
  const checks: DoctorCheck[] = [];

  // ── Node.js ─────────────────────────────────────────────────────────────
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push(
    await timed("node", () =>
      major >= 22
        ? { status: "PASS", detail: `node ${process.versions.node}` }
        : { status: "FAIL", detail: `node ${process.versions.node} too old; >=22 required (strip-types runtime)` },
    ),
  );

  // ── configuration + migration ────────────────────────────────────────────
  let config: RuntimeConfig = DEFAULT_CONFIG;
  checks.push(
    await timed("config", async () => {
      const file = options.configFile ?? path.join(cwd, "config", "default.json");
      if (!fs.existsSync(file)) {
        return { status: "WARN", detail: "no config file found; using built-in defaults" };
      }
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      const { appliedMigrations, droppedKeys } = migrateRawConfig(raw);
      const migratedNote = appliedMigrations.length > 0 ? `migrated from v0 (${droppedKeys.length} obsolete keys)` : `v${CONFIG_VERSION}`;
      config = await loadConfig(file);
      return { status: "PASS", detail: migratedNote };
    }),
  );

  // ── sandbox policy sanity ────────────────────────────────────────────────
  checks.push(
    await timed("sandbox", () => {
      const policy = defaultSandboxPolicy();
      if (policy.deniedRoots.length === 0) {
        return { status: "WARN", detail: "no denied roots configured" };
      }
      return { status: "PASS", detail: `${policy.deniedRoots.length} denied roots, ${policy.blockedCommandTokens.length} blocked command tokens` };
    }),
  );

  // ── runtime + tool registry + model router (mock provider) ──────────────
  let runtime: FluxRuntime | null = null;
  checks.push(
    await timed("runtime", () => {
      runtime = createRuntime({ provider: new MockLlmProvider(), cwd, config });
      const tools = runtime.registry.list().length;
      const models = runtime.modelRouter.listModels().length;
      if (tools === 0) return { status: "FAIL", detail: "tool registry is empty" };
      return { status: "PASS", detail: `${tools} tools registered, ${models} model descriptor(s)` };
    }),
  );

  // ── storage write/read round-trip (long-term memory backend dir) ────────
  checks.push(
    await timed("storage", () => {
      const probe = path.join(os.tmpdir(), `fluxagent-doctor-${Date.now()}`);
      try {
        fs.mkdirSync(probe, { recursive: true });
        const file = path.join(probe, "probe.json");
        fs.writeFileSync(file, JSON.stringify({ ok: true }));
        const back = JSON.parse(fs.readFileSync(file, "utf8")) as { ok: boolean };
        return back.ok ? { status: "PASS", detail: "temp write/read OK" } : { status: "FAIL", detail: "read-back mismatch" };
      } finally {
        fs.rmSync(probe, { recursive: true, force: true });
      }
    }),
  );

  // ── filesystem: memory directory writable ────────────────────────────────
  checks.push(
    await timed("memory-dir", () => {
      const dir = path.join(cwd, config.memory.longTermDirectory);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return { status: "PASS", detail: `${config.memory.longTermDirectory} writable` };
      } catch (err) {
        return { status: "WARN", detail: `not writable: ${err instanceof Error ? err.message : String(err)}` };
      }
    }),
  );

  // ── python availability + worker protocol ───────────────────────────────
  checks.push(
    await timed("python", async () => {
      if (options.skipPython) return { status: "SKIP", detail: "python check disabled by caller" };
      const interpreter = config.python.interpreter;
      const workerScript = path.join(cwd, config.python.workerScript);
      if (!fs.existsSync(workerScript)) return { status: "SKIP", detail: "worker script not present" };
      const version = await execQuick(interpreter, ["--version"], 8_000);
      if (!version.ok) return { status: "FAIL", detail: `interpreter "${interpreter}" not runnable` };
      const probe = await execQuick(
        interpreter,
        ["-c", `import json,sys;sys.stdout.write(json.dumps({"ok":True}))`],
        8_000,
      );
      if (!probe.ok) return { status: "FAIL", detail: `python ${version.stdout.trim()} but basic json/stdout check failed` };
      return { status: "PASS", detail: version.stdout.trim() };
    }),
  );

  // ── permissions: approval requester configured ───────────────────────────
  checks.push(
    await timed("permissions", () => {
      if (config.security.mode === "auto-approve") {
        return { status: "WARN", detail: "security.mode=auto-approve — interactive approvals are bypassed (dev only)" };
      }
      if (config.security.mode === "deny-all") {
        return { status: "WARN", detail: "security.mode=deny-all — every USER_CONFIRMATION+ action will be refused" };
      }
      return { status: "PASS", detail: `mode=${config.security.mode}, ceiling=${config.security.ceiling}` };
    }),
  );

  const healthy = checks.every((c) => c.status === "PASS" || c.status === "SKIP");
  return {
    healthy,
    platform: facts.key,
    nodeVersion: process.versions.node,
    checks,
    configSummary: describeConfig(config),
  };
}

/** Minimal one-shot subprocess runner (bounded, no hangs). */
function execQuick(command: string, args: readonly string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; stdout: string; stderr: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const child = spawn(command, args, { shell: false, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        done({ ok: false, stdout, stderr: "timeout" });
      }, timeoutMs);
      child.stdout?.on("data", (d) => (stdout += String(d)));
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        clearTimeout(timer);
        done({ ok: false, stdout, stderr: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ ok: code === 0, stdout, stderr });
      });
    } catch (err) {
      done({ ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Human-readable rendering: `PASS  name — detail`. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`FluxAgent doctor — platform: ${report.platform}, node: ${report.nodeVersion}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`  ${check.status.padEnd(5)} ${check.name.padEnd(12)} ${check.detail} (${check.durationMs}ms)`);
  }
  lines.push("");
  lines.push(report.healthy ? "Overall: HEALTHY" : "Overall: UNHEALTHY (see FAIL/WARN entries above)");
  return lines.join("\n");
}
