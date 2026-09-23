/**
 * FluxAgent — high-level computer-use capability layer (Phase 3).
 *
 * ComputerController composes the existing platform controllers (files,
 * command, screen, keyboard, mouse, applications, system) into one facade
 * the model-facing layer can use for "operate the computer" tasks.
 *
 * Design invariants:
 *   - This layer does NOT bypass anything: every operation calls the existing
 *     controllers, which enforce the sandbox policy. Permission gating rides
 *     the same PermissionManager via the tool layer (tools wrap these calls).
 *   - Capability detection is honest: if a controller's backend is the
 *     unavailable placeholder, the capability reports `available: false` with
 *     a reason — never a fake success, never a fake screenshot.
 *   - Platform-specific quirks stay inside the controllers; this layer is
 *     platform-neutral.
 */

import { FluxError } from "../utils/errors.ts";
import type { FileController, DirectoryEntry, FileMetadata } from "../controllers/files.ts";
import type { CommandController, CommandResult } from "../controllers/command.ts";
import type { ScreenController, Screenshot, ScreenDimensions } from "../controllers/screen.ts";
import type { KeyboardController } from "../controllers/keyboard.ts";
import type { MouseController, Point } from "../controllers/mouse.ts";
import type { ApplicationController, ApplicationState } from "../controllers/application.ts";
import type { SystemController } from "../controllers/system.ts";

/** A capability the computer layer can expose (or honestly report missing). */
export interface ComputerCapability {
  readonly name: string;
  readonly available: boolean;
  /** Why the capability is unavailable, when it is not. */
  readonly reason?: string;
}

export interface ComputerControllerDeps {
  readonly files: FileController;
  readonly command: CommandController;
  readonly screen: ScreenController;
  readonly keyboard: KeyboardController;
  readonly mouse: MouseController;
  readonly apps: ApplicationController;
  readonly system: SystemController;
}

export interface ComputerOpenOptions {
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export interface ComputerRunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Shell to prefer. Controllers already pick per-platform defaults. */
  readonly shell?: string;
}

/** Probe whether a throwing controller is backed by a real implementation. */
function probe(backendName: () => string, isPlaceholder: boolean): ComputerCapability {
  return isPlaceholder
    ? { name: backendName(), available: false, reason: "no OS backend wired yet (Python bridge / native addon pending)" }
    : { name: backendName(), available: true };
}

export class ComputerController {
  private readonly deps: ComputerControllerDeps;

  constructor(deps: ComputerControllerDeps) {
    this.deps = deps;
  }

  // ── capability detection ────────────────────────────────────────────────────

  /**
   * Report which capabilities are actually usable. Input injection and screen
   * capture depend on optional backends; the honest answer for an unwired
   * backend is `available: false`, not a runtime surprise later.
   */
  capabilities(): ComputerCapability[] {
    const screenAvailable = screenBackendWired(this.deps.screen);
    const inputAvailable = inputBackendWired(this.deps.keyboard, this.deps.mouse);
    return [
      { name: "filesystem", available: true },
      { name: "command", available: true },
      screenAvailable
        ? { name: "screen", available: true }
        : { name: "screen", available: false, reason: "no capture backend (Python bridge / native addon pending)" },
      inputAvailable
        ? { name: "input", available: true }
        : { name: "input", available: false, reason: "no injection backend (Python bridge / native addon pending)" },
      { name: "applications", available: appBackendWired(this.deps.apps) },
      { name: "system", available: true },
    ];
  }

  /** True only if the named capability exists AND is backed by a real implementation. */
  isAvailable(capability: "filesystem" | "command" | "screen" | "input" | "applications" | "system"): boolean {
    const cap = this.capabilities().find((c) => c.name === capability);
    return cap?.available === true;
  }

  // ── filesystem (READ_ONLY-ish; sandbox enforced inside FileController) ──────

  async readFile(path: string): Promise<string> {
    return this.deps.files.readText(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.deps.files.writeText(path, content);
  }

  async listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    return this.deps.files.list(path);
  }

  async fileInfo(path: string): Promise<FileMetadata> {
    return this.deps.files.metadata(path);
  }

  // ── command execution (permission-gated at the tool layer) ─────────────────

  async runCommand(command: string, options: ComputerRunOptions = {}): Promise<CommandResult> {
    return this.deps.command.run({
      command,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * Run an executable with separate args (no shell interpolation — the
   * controller spawns directly, which is the safe path).
   */
  async runCommandWithArgs(command: string, args: readonly string[], options: ComputerRunOptions = {}): Promise<CommandResult> {
    return this.deps.command.run({
      command,
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
    });
  }

  // ── screen (structured capability errors when no backend) ──────────────────

  async screenDimensions(): Promise<ScreenDimensions> {
    return this.deps.screen.getDimensions();
  }

  async screenshot(monitor = 0): Promise<Screenshot> {
    return this.deps.screen.screenshot(monitor);
  }

  // ── input ──────────────────────────────────────────────────────────────────

  async typeText(text: string, opts?: { intervalMs?: number }): Promise<void> {
    return this.deps.keyboard.typeText(text, opts);
  }

  async keyPress(key: string, modifiers?: readonly string[]): Promise<void> {
    return this.deps.keyboard.pressKey({ key, modifiers: modifiers as never[] | undefined });
  }

  async click(x: number, y: number, button: "left" | "right" | "middle" = "left"): Promise<void> {
    if (button === "right") return this.deps.mouse.rightClick({ point: { x, y } });
    return this.deps.mouse.click({ point: { x, y }, button });
  }

  async mousePosition(): Promise<Point> {
    return this.deps.mouse.position();
  }

  // ── applications ───────────────────────────────────────────────────────────

  async launchApplication(executable: string, options: ComputerOpenOptions = {}): Promise<unknown> {
    return this.deps.apps.launch(executable, { args: options.args, cwd: options.cwd });
  }

  async closeApplication(name: string): Promise<void> {
    return this.deps.apps.close(name);
  }

  async inspectApplication(nameOrTitle: string): Promise<ApplicationState> {
    return this.deps.apps.inspect(nameOrTitle);
  }

  async isApplicationRunning(nameOrTitle: string): Promise<boolean> {
    return this.deps.apps.detect(nameOrTitle);
  }
}

/** Check whether the ScreenController still holds the placeholder backend. */
function screenBackendWired(screen: ScreenController): boolean {
  try {
    // The unavailable backend is detectable by name without triggering errors.
    const backend = (screen as unknown as { backend: { name: string } }).backend;
    return backend?.name !== "unavailable";
  } catch {
    return false;
  }
}

function inputBackendWired(keyboard: KeyboardController, mouse: MouseController): boolean {
  try {
    const kb = (keyboard as unknown as { backend: { name: string } }).backend;
    const ms = (mouse as unknown as { backend: { name: string } }).backend;
    return kb?.name !== "unavailable" && ms?.name !== "unavailable";
  } catch {
    return false;
  }
}

function appBackendWired(_apps: ApplicationController): boolean {
  // Application ops are Windows-only today; the controller itself raises
  // PlatformUnsupportedError off-Windows, which the tool layer surfaces
  // as a structured error. Availability on win32:
  return process.platform === "win32";
}

/** Structured capability error for callers that want to fail explicitly. */
export function capabilityError(capability: string, reason: string): FluxError {
  return new FluxError({
    code: "E_PLATFORM_UNSUPPORTED",
    message: `Computer capability "${capability}" is unavailable: ${reason}`,
    hint: "Check ComputerController.capabilities() before calling, or wire the missing backend.",
  });
}
