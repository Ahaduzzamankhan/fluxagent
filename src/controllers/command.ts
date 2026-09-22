/**
 * FluxAgent — command controller.
 *
 * Executes OS commands with argument arrays (never a raw shell string),
 * timeout, env passthrough, and captured stdout/stderr/exit code. The LLM
 * cannot reach this layer directly — only registered command tools can.
 */

import { spawn } from "node:child_process";

import { CommandBlockedError, toFluxError } from "../utils/errors.ts";
import {
  enforceCommandAllowed,
  type SandboxPolicy,
  DEFAULT_SANDBOX_POLICY,
} from "../security/sandbox.ts";

export interface CommandControllerOptions {
  readonly sandboxPolicy?: SandboxPolicy;
  /** Default timeout in ms (0 = no timeout). */
  readonly defaultTimeoutMs?: number;
  /** Max captured stdout/stderr bytes to keep. */
  readonly maxOutputBytes?: number;
}

export interface CommandSpec {
  /** Executable name or path, e.g. "git", "npm", "C:\\tools\\app.exe". */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Extra env merged over process.env. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Path to redirect stdin from, or omit for no stdin. */
  readonly stdin?: string;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly signal?: string;
}

export class CommandController {
  private readonly policy: SandboxPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: CommandControllerOptions = {}) {
    this.policy = options.sandboxPolicy ?? DEFAULT_SANDBOX_POLICY;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  }

  /** Check policy without running (used by tools/tests). */
  check(spec: CommandSpec): void {
    enforceCommandAllowed(spec.command, spec.args ?? [], this.policy);
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    // Policy gate first.
    enforceCommandAllowed(spec.command, spec.args ?? [], this.policy);

    const timeoutMs = spec.timeoutMs ?? this.defaultTimeoutMs;
    const started = Date.now();

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: spec.env ? { ...process.env, ...spec.env } : process.env,
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: false,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeoutMs)
          : null;

      const cap = (s: string): string =>
        Buffer.byteLength(s) > this.maxOutputBytes
          ? `${s.slice(0, this.maxOutputBytes)}…[truncated]`
          : s;

      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
        if (Buffer.byteLength(stdout) > this.maxOutputBytes * 2) stdout = cap(stdout);
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
        if (Buffer.byteLength(stderr) > this.maxOutputBytes * 2) stderr = cap(stderr);
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(toFluxError(err));
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          exitCode: code,
          stdout: cap(stdout),
          stderr: cap(stderr),
          timedOut,
          durationMs: Date.now() - started,
          command: spec.command,
          args: spec.args ?? [],
          ...(signal ? { signal } : {}),
        });
      });

      if (spec.stdin) {
        child.stdin?.write(spec.stdin);
      }
      child.stdin?.end();
    });
  }
}
