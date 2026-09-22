/**
 * FluxAgent — system controller.
 *
 * Host information: platform details, env vars (redacted on output by the
 * logger), disks, and a small set of safe queries. No privileged ops here —
 * those belong to explicit PRIVILEGED tools later.
 */

import * as os from "node:os";
import type { CommandController } from "./command.ts";

export interface SystemInfo {
  readonly platform: string;
  readonly release: string;
  readonly arch: string;
  readonly hostname: string;
  readonly cpuModel: string;
  readonly totalMemMb: number;
  readonly freeMemMb: number;
  readonly nodeVersion: string;
  readonly uptimeSeconds: number;
}

export interface EnvOptions {
  /** Only these keys are returned (recommended). */
  readonly allowlist?: readonly string[];
  /** Values shorter than this are kept; otherwise masked. */
  readonly maxPlainValueLength?: number;
}

export class SystemController {
  private readonly command: CommandController;

  constructor(command: CommandController) {
    this.command = command;
  }

  info(): SystemInfo {
    const cpus = os.cpus();
    return {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpuModel: cpus[0]?.model ?? "unknown",
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      nodeVersion: process.version,
      uptimeSeconds: Math.round(os.uptime()),
    };
  }

  /** Env reader with masking for long values (never dump full secrets). */
  env(options: EnvOptions = {}): Record<string, string> {
    const maxPlain = options.maxPlainValueLength ?? 8;
    const out: Record<string, string> = {};
    const keys = options.allowlist ?? Object.keys(process.env);
    for (const k of keys) {
      const v = process.env[k];
      if (v === undefined) continue;
      out[k] = v.length <= maxPlain ? v : `${v.slice(0, 2)}…[masked ${v.length} chars]`;
    }
    return out;
  }

  async disks(): Promise<{ readonly drive: string; readonly label?: string }[]> {
    const res = await this.command.run({
      command: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-PSDrive -PSProvider FileSystem | Select-Object Name,Root | ConvertTo-Json -Compress",
      ],
      timeoutMs: 15_000,
    });
    if (res.exitCode !== 0) return [];
    try {
      const parsed: unknown = JSON.parse(res.stdout);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((d): d is { Name?: string; Root?: string } => typeof d === "object" && d !== null)
        .map((d) => ({ drive: d.Root ?? d.Name ?? "?" }));
    } catch {
      return [];
    }
  }
}
