/**
 * FluxAgent — application controller.
 *
 * Conceptual application operations composed from process + window + command
 * controllers. Platform specifics stay here, not in the agent.
 */

import { PlatformUnsupportedError, FileNotFoundError } from "../utils/errors.ts";
import type { CommandController } from "./command.ts";
import type { ProcessController, ProcessInfo } from "./process.ts";
import type { WindowController, WindowInfo } from "./window.ts";

export interface LaunchOptions {
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Wait for the process to exit instead of detaching. */
  readonly wait?: boolean;
  readonly timeoutMs?: number;
}

export interface ApplicationState {
  readonly name: string;
  readonly running: boolean;
  readonly processes: readonly ProcessInfo[];
  readonly windows: readonly WindowInfo[];
}

export class ApplicationController {
  private readonly command: CommandController;
  private readonly processes: ProcessController;
  private readonly windows: WindowController;
  private readonly platform: NodeJS.Platform;

  constructor(
    command: CommandController,
    processes: ProcessController,
    windows: WindowController,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.command = command;
    this.processes = processes;
    this.windows = windows;
    this.platform = platform;
  }

  private assertWindows(op: string): void {
    if (this.platform !== "win32") throw new PlatformUnsupportedError(op, this.platform);
  }

  /** Launch by executable path or start-menu alias (uses cmd start for aliases). */
  async launch(executable: string, options: LaunchOptions = {}): Promise<ProcessInfo | CommandResultAlias> {
    this.assertWindows("application.launch");
    const isPath = /[\\/]/.test(executable) || executable.toLowerCase().endsWith(".exe");
    if (isPath) {
      return this.processes.start({
        executable,
        args: options.args,
        cwd: options.cwd,
        detached: !options.wait,
      });
    }
    // Alias (e.g. "notepad", "mspaint"): resolve via cmd start, detached.
    const res = await this.command.run({
      command: "cmd",
      args: ["/c", "start", "", executable, ...(options.args ?? [])],
      cwd: options.cwd,
      timeoutMs: options.wait ? (options.timeoutMs ?? 30_000) : 10_000,
    });
    if (res.exitCode !== 0) {
      throw new FileNotFoundError(executable);
    }
    return { launched: true, via: "cmd start" };
  }

  /** Detect whether an application is running by image name or window title. */
  async detect(nameOrTitle: string): Promise<boolean> {
    this.assertWindows("application.detect");
    const procs = await this.processes.listProcesses();
    const needle = nameOrTitle.toLowerCase();
    if (procs.some((p) => p.name.toLowerCase().includes(needle))) return true;
    const wins = await this.windows.listWindows();
    return wins.some((w) => w.title.toLowerCase().includes(needle));
  }

  async inspect(nameOrTitle: string): Promise<ApplicationState> {
    this.assertWindows("application.inspect");
    const procs = await this.processes.listProcesses();
    const needle = nameOrTitle.toLowerCase();
    const matched = procs.filter((p) => p.name.toLowerCase().includes(needle));
    const wins = (await this.windows.listWindows()).filter((w) =>
      w.title.toLowerCase().includes(needle),
    );
    return { name: nameOrTitle, running: matched.length > 0 || wins.length > 0, processes: matched, windows: wins };
  }

  async focusWindow(titleSubstring: string): Promise<void> {
    this.assertWindows("application.focus");
    const matches = await this.windows.findWindows(titleSubstring);
    const target = matches[0];
    if (!target) throw new WindowNotFoundErrorLike(titleSubstring);
    await this.windows.focus(target.handle);
  }

  /** Close by window title, falling back to process termination. */
  async close(nameOrTitle: string, options: { force?: boolean } = {}): Promise<void> {
    this.assertWindows("application.close");
    const matches = await this.windows.findWindows(nameOrTitle);
    if (matches.length > 0) {
      await Promise.all(matches.map((w) => this.windows.close(w.handle)));
      return;
    }
    const procs = await this.processes.listProcesses();
    const needle = nameOrTitle.toLowerCase();
    const targets = procs.filter((p) => p.name.toLowerCase().includes(needle));
    if (targets.length === 0) {
      throw new WindowNotFoundErrorLike(nameOrTitle);
    }
    await Promise.all(targets.map((p) => this.processes.terminate(p.pid, { force: options.force ?? true })));
  }
}

/** Lightweight alias result for alias launches. */
export interface CommandResultAlias {
  readonly launched: boolean;
  readonly via: string;
}

function WindowNotFoundErrorLike(hint: string): Error {
  const err = new Error(`Application/window not found: ${hint}`);
  err.name = "ApplicationNotFoundError";
  return err;
}
