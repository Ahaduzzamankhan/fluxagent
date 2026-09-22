/**
 * FluxAgent — process controller.
 *
 * Cross-platform without native deps:
 *   - Windows: tasklist / taskkill
 *   - Linux/macOS: ps / kill
 * Platform-specific logic stays isolated here; other controllers consume the
 * typed API only. Unknown platforms raise `E_PLATFORM_UNSUPPORTED`.
 */

import { spawn } from "node:child_process";

import { PlatformUnsupportedError, toFluxError } from "../utils/errors.ts";
import { normalizePlatform } from "../platform/platform.ts";
import type { CommandController } from "./command.ts";

export interface ProcessInfo {
  readonly pid: number;
  readonly name: string;
  readonly memoryKb?: number;
  readonly sessionName?: string;
}

export interface StartOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
  /** Detached — keep running after agent exits (default true for launches). */
  readonly detached?: boolean;
}

export class ProcessController {
  private readonly command: CommandController;
  private readonly platform: NodeJS.Platform;
  private readonly kind: "windows" | "posix";

  constructor(command: CommandController, platform: NodeJS.Platform = process.platform) {
    this.command = command;
    this.platform = platform;
    const key = normalizePlatform(platform);
    this.kind = key === "windows" ? "windows" : "posix";
  }

  private assertSupported(op: string): "windows" | "posix" {
    if (this.platform !== "win32" && this.platform !== "darwin" && this.platform !== "linux" &&
        this.platform !== "freebsd" && this.platform !== "openbsd") {
      throw new PlatformUnsupportedError(op, this.platform);
    }
    return this.kind;
  }

  async listProcesses(nameFilter?: string): Promise<ProcessInfo[]> {
    const kind = this.assertSupported("process.list");
    if (kind === "windows") {
      const args = ["/FO", "CSV", "/NH"];
      if (nameFilter) args.push("/FI", `IMAGENAME eq ${nameFilter}`);
      const res = await this.command.run({ command: "tasklist", args });
      if (res.exitCode !== 0) throw toFluxError(new Error(`tasklist failed: ${res.stderr}`));
      return parseTasklist(res.stdout);
    }
    // POSIX: `ps -eo pid=,comm=` (name only; rss needs -o rss= which differs per platform).
    const res = await this.command.run({ command: "ps", args: ["-eo", "pid=,comm="] });
    if (res.exitCode !== 0) throw toFluxError(new Error(`ps failed: ${res.stderr}`));
    return parsePsOutput(res.stdout, nameFilter);
  }

  async start(spec: StartOptions & { executable: string }): Promise<ProcessInfo> {
    // `start` via cmd would need shell; we spawn directly instead.
    return new Promise((resolve, reject) => {
      const child = spawn(spec.executable, spec.args ?? [], {
        cwd: spec.cwd,
        env: spec.env ? { ...process.env, ...spec.env } : process.env,
        detached: spec.detached ?? true,
        windowsHide: !(spec.detached ?? true),
        stdio: "ignore",
      });
      child.unref();
      child.on("error", (err) => reject(toFluxError(err)));
      // PID is available synchronously after spawn success.
      if (child.pid) {
        resolve({ pid: child.pid, name: exeName(spec.executable) });
      }
    });
  }

  async terminate(pid: number, options: { force?: boolean } = {}): Promise<void> {
    const kind = this.assertSupported("process.terminate");
    if (kind === "windows") {
      const res = await this.command.run({
        command: "taskkill",
        args: ["/PID", String(pid), ...(options.force ? ["/F"] : [])],
      });
      if (res.exitCode !== 0) {
        throw toFluxError(new Error(`taskkill failed: ${res.stderr || res.stdout}`));
      }
      return;
    }
    // POSIX: graceful SIGTERM first; SIGKILL only when force is requested.
    const signal = options.force ? "SIGKILL" : "SIGTERM";
    const res = await this.command.run({ command: "kill", args: ["-s", signal, String(pid)] });
    if (res.exitCode !== 0) {
      throw toFluxError(new Error(`kill ${signal} ${pid} failed: ${res.stderr || res.stdout}`));
    }
  }

  async inspect(pid: number): Promise<ProcessInfo> {
    const kind = this.assertSupported("process.inspect");
    if (kind === "windows") {
      const res = await this.command.run({
        command: "tasklist",
        args: ["/FO", "CSV", "/NH", "/FI", `PID eq ${pid}`],
      });
      const found = parseTasklist(res.stdout).find((p) => p.pid === pid);
      if (!found) throw new ProcessNotFoundError(pid);
      return found;
    }
    const res = await this.command.run({ command: "ps", args: ["-p", String(pid), "-o", "pid=,comm="] });
    const found = parsePsOutput(res.stdout).find((p) => p.pid === pid);
    if (!found) throw new ProcessNotFoundError(pid);
    return found;
  }
}

export class ProcessNotFoundError extends Error {
  constructor(pid: number) {
    super(`Process with PID ${pid} not found`);
    this.name = "ProcessNotFoundError";
  }
}

// ─── parsing ──────────────────────────────────────────────────────────────────

/** Parse `tasklist /FO CSV /NH` output. Exported for tests. */
export function parseTasklist(csv: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("\"")) continue;
    const cells = parseCsvLine(trimmed);
    // "name","pid","session name","session num","mem usage"
    const name = cells[0];
    const pidRaw = cells[1];
    if (!name || !pidRaw) continue;
    const pid = Number.parseInt(pidRaw.replace(/[^0-9]/g, ""), 10);
    if (!Number.isInteger(pid)) continue;
    const memRaw = cells[4];
    const memoryKb = memRaw
      ? Number.parseInt(memRaw.replace(/[^0-9]/g, ""), 10)
      : undefined;
    out.push({
      pid,
      name,
      ...(memoryKb !== undefined && Number.isInteger(memoryKb) ? { memoryKb } : {}),
      ...(cells[2] ? { sessionName: cells[2] } : {}),
    });
  }
  return out;
}

/**
 * Parse `ps -eo pid=,comm=` output. Exported for tests.
 * Lines look like: `  1234 /usr/bin/node` or `  567 node` (comm may be a path).
 */
export function parsePsOutput(output: string, nameFilter?: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^\s*(\d+)\s+(.+)$/.exec(trimmed);
    if (!m) continue;
    const pid = Number.parseInt(m[1]!, 10);
    if (!Number.isInteger(pid)) continue;
    const full = m[2]!.trim();
    const name = full.split("/").pop() ?? full;
    if (nameFilter && !name.toLowerCase().includes(nameFilter.toLowerCase())) continue;
    out.push({ pid, name });
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        cur += "\"";
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function exeName(executable: string): string {
  const base = executable.split(/[\\/]/).pop() ?? executable;
  return base.toLowerCase().endsWith(".exe") ? base : `${base}.exe`;
}
