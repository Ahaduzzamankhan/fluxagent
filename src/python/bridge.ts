/**
 * FluxAgent — Python bridge (TypeScript side).
 *
 * Spawns `python/worker.py` and speaks a newline-delimited JSON protocol over
 * stdin/stdout. Modules on the Python side: vision, ocr, embeddings,
 * documents. Stdlib-only Python; heavy deps are clearly marked there.
 *
 * Protocol:
 *   → {"id":"req_1","op":"execute","module":"vision","function":"describe","args":{...}}
 *   ← {"id":"req_1","ok":true,"result":{...}}
 *   ← {"id":"req_1","ok":false,"error":{"code":"...","message":"..."}}
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { EventEmitter } from "node:events";

import { PythonBridgeError, toFluxError } from "../utils/errors.ts";
import { ids } from "../utils/ids.ts";
import { Logger } from "../utils/logger.ts";

export interface PythonBridgeOptions {
  readonly interpreter?: string;
  readonly workerScript?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface PythonExecuteOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class PythonBridge {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = "";
  private readonly opts: Required<Pick<PythonBridgeOptions, "interpreter" | "workerScript" | "timeoutMs">> &
    PythonBridgeOptions;
  private readonly events = new EventEmitter();

  constructor(options: PythonBridgeOptions = {}) {
    this.opts = {
      interpreter: options.interpreter ?? "python",
      workerScript: options.workerScript ?? path.join("python", "worker.py"),
      timeoutMs: options.timeoutMs ?? 30_000,
      cwd: options.cwd,
      logger: options.logger,
    };
  }

  /** Spawn the worker lazily; safe to call multiple times. */
  ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process) return this.process;
    const child = spawn(this.opts.interpreter, ["-u", this.opts.workerScript], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.opts.logger?.debug("[python-worker] " + chunk.trim());
    });
    child.on("exit", (code) => {
      this.process = null;
      this.failAllPending(new PythonBridgeError(`python worker exited (code ${code})`));
    });

    this.process = child;
    return child;
  }

  /**
   * Execute `module.function` with args. Equivalent to the conceptual
   * python.execute("vision", args) from the spec.
   */
  async execute<T = unknown>(
    module: string,
    fn: string,
    args: Record<string, unknown> = {},
    options: PythonExecuteOptions = {},
  ): Promise<T> {
    const child = this.ensureProcess();
    const id = ids.run(); // unique per request
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;

    const payload = JSON.stringify({ id, op: "execute", module, function: fn, args }) + "\n";
    const promise = new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new PythonBridgeError(`python call timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
    });

    child.stdin.write(payload);
    return promise;
  }

  /** Event seam for the future UI: "response" | "error" | "exit". */
  on(event: string, handler: (...args: unknown[]) => void): () => void {
    this.events.on(event, handler);
    return () => this.events.off(event, handler);
  }

  async shutdown(): Promise<void> {
    if (!this.process) return;
    const child = this.process;
    this.process = null;
    try {
      child.stdin.write(JSON.stringify({ id: "shutdown", op: "shutdown" }) + "\n");
    } catch {
      // already closed
    }
    child.kill();
    this.failAllPending(new PythonBridgeError("bridge shut down"));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: string; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.logger?.warn("python worker sent non-JSON line", { line: line.slice(0, 200) });
      return;
    }
    if (!msg.id) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else {
      pending.reject(
        new PythonBridgeError(msg.error?.message ?? "python call failed", {
          code: msg.error?.code,
        }),
      );
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

export { toFluxError };
