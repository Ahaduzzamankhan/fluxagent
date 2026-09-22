/**
 * FluxAgent — screen controller.
 *
 * IMPORTANT: no fake screenshots. The interface and dispatch structure are
 * complete; the Windows capture implementation requires a native addon or the
 * Python bridge (mss/Pillow) and is intentionally left as a typed error until
 * that dependency is added.
 *
 * TODO(dependency): screenshot capture needs one of:
 *   - Python bridge + `mss` / `Pillow` (preferred; python/worker.py already
 *     exposes a `screen.info` endpoint via ctypes that works stdlib-only)
 *   - or a native Node addon (e.g. screenshot-desktop binding)
 * Neither is installed now per project rules.
 */

import { PlatformUnsupportedError, FluxError } from "../utils/errors.ts";

export interface MonitorInfo {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isPrimary: boolean;
}

export interface ScreenDimensions {
  readonly width: number;
  readonly height: number;
  readonly monitors: readonly MonitorInfo[];
}

export interface Screenshot {
  /** PNG-encoded bytes. */
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly monitor: number;
  readonly capturedAt: string;
}

/** Async capture backend seam. */
export interface ScreenCaptureBackend {
  readonly name: string;
  dimensions(): Promise<ScreenDimensions>;
  capture(options?: { monitor?: number }): Promise<Screenshot>;
}

/**
 * Stdlib-only monitor enumeration via the Python worker (ctypes GetSystemMetrics)
 * — wired by the runtime when the Python bridge is enabled. Until then the
 * default backend reports an actionable error instead of pretending.
 */
export class UnavailableScreenBackend implements ScreenCaptureBackend {
  readonly name = "unavailable";

  async dimensions(): Promise<ScreenDimensions> {
    throw new FluxError({
      code: "E_PLATFORM_UNSUPPORTED",
      message:
        "Screen dimensions require the Python bridge backend (worker.py screen.info) — enable python in config",
      hint: "Set runtime config python.enabled=true, or provide a ScreenCaptureBackend.",
    });
  }

  async capture(): Promise<Screenshot> {
    throw new FluxError({
      code: "E_PLATFORM_UNSUPPORTED",
      message:
        "Screenshot capture is not available yet: requires the Python bridge (mss/Pillow) or a native addon",
      hint: "Enable python.enabled in config once dependencies are installed; no fake screenshots are produced.",
    });
  }
}

export class ScreenController {
  private backend: ScreenCaptureBackend;
  private readonly platform: NodeJS.Platform;

  constructor(backend: ScreenCaptureBackend = new UnavailableScreenBackend(), platform: NodeJS.Platform = process.platform) {
    this.backend = backend;
    this.platform = platform;
  }

  private assertSupported(op: string): void {
    if (this.platform !== "win32") {
      throw new PlatformUnsupportedError(op, this.platform);
    }
  }

  async getDimensions(): Promise<ScreenDimensions> {
    this.assertSupported("screen.dimensions");
    return this.backend.dimensions();
  }

  async listMonitors(): Promise<readonly MonitorInfo[]> {
    const dims = await this.getDimensions();
    return dims.monitors;
  }

  /** Capture a full monitor (or the primary by default) as PNG. */
  async screenshot(monitor = 0): Promise<Screenshot> {
    this.assertSupported("screen.screenshot");
    return this.backend.capture({ monitor });
  }

  setBackend(backend: ScreenCaptureBackend): void {
    this.backend = backend;
  }
}
