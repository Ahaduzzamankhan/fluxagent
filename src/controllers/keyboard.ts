/**
 * FluxAgent — keyboard controller.
 *
 * Typed API only; injection requires a native/Python backend (SendInput via
 * Python ctypes through the bridge, or robotjs/nut-js later). The interface is
 * real, implementations are backend-injected, and the default backend throws
 * an actionable error — no fake input.
 *
 * TODO(dependency): input injection needs one of:
 *   - Python bridge worker with ctypes SendInput (stdlib-only implementation
 *     planned in python/keyboard.py — see worker.py endpoints)
 *   - or `@nut-tree/nut-js` / `robotjs` npm packages later.
 */

import { FluxError } from "../utils/errors.ts";

export type ModifierKey = "ctrl" | "alt" | "shift" | "win" | "meta";

export interface KeyEvent {
  readonly key: string; // e.g. "a", "Enter", "F5", "ArrowUp"
  readonly modifiers?: readonly ModifierKey[];
}

/** Backend seam — implemented by Python bridge or a future native addon. */
export interface InputInjectionBackend {
  readonly name: string;
  keyDown(e: KeyEvent): Promise<void>;
  keyUp(e: KeyEvent): Promise<void>;
  typeText(text: string, opts?: { intervalMs?: number }): Promise<void>;
  pressKey(e: KeyEvent): Promise<void>;
  hotkey(keys: readonly string[]): Promise<void>;
}

export class UnavailableInputBackend implements InputInjectionBackend {
  readonly name = "unavailable";

  private fail(op: string): never {
    throw new FluxError({
      code: "E_PLATFORM_UNSUPPORTED",
      message: `Keyboard.${op} requires an input-injection backend (Python bridge SendInput or a native addon)`,
      hint: "Wire a real InputInjectionBackend once dependencies are installed; FluxAgent will not fake input events.",
    });
  }

  keyDown(): Promise<void> {
    return Promise.reject(this.fail("keyDown"));
  }
  keyUp(): Promise<void> {
    return Promise.reject(this.fail("keyUp"));
  }
  async typeText(): Promise<void> {
    this.fail("typeText");
  }
  async pressKey(): Promise<void> {
    this.fail("pressKey");
  }
  async hotkey(): Promise<void> {
    this.fail("hotkey");
  }
}

export class KeyboardController {
  private backend: InputInjectionBackend;

  constructor(backend: InputInjectionBackend = new UnavailableInputBackend()) {
    this.backend = backend;
  }

  keyDown(e: KeyEvent): Promise<void> {
    return this.backend.keyDown(e);
  }

  keyUp(e: KeyEvent): Promise<void> {
    return this.backend.keyUp(e);
  }

  typeText(text: string, opts?: { intervalMs?: number }): Promise<void> {
    if (typeof text !== "string" || text.length === 0) {
      return Promise.reject(new Error("typeText: text must be a non-empty string"));
    }
    return this.backend.typeText(text, opts);
  }

  pressKey(e: KeyEvent): Promise<void> {
    return this.backend.pressKey(e);
  }

  /** e.g. hotkey(["ctrl", "shift", "Escape"]) */
  hotkey(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return Promise.reject(new Error("hotkey: at least one key required"));
    return this.backend.hotkey(keys);
  }

  setBackend(backend: InputInjectionBackend): void {
    this.backend = backend;
  }
}
