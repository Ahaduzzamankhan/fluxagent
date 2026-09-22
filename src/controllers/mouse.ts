/**
 * FluxAgent — mouse controller.
 *
 * Typed API only; the injection backend (Python bridge SendInput or a native
 * addon) is injected. Default backend throws actionable errors — no fake
 * pointer movement.
 *
 * TODO(dependency): same options as keyboard.ts.
 */

import { FluxError } from "../utils/errors.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type MouseButton = "left" | "right" | "middle";

export interface ClickOptions {
  readonly button?: MouseButton;
  readonly point?: Point;
}

export interface ScrollOptions {
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly at?: Point;
}

/** Backend seam. */
export interface MouseBackend {
  readonly name: string;
  move(p: Point): Promise<void>;
  down(opts?: ClickOptions): Promise<void>;
  up(opts?: ClickOptions): Promise<void>;
  click(opts?: ClickOptions): Promise<void>;
  doubleClick(opts?: ClickOptions): Promise<void>;
  scroll(opts: ScrollOptions): Promise<void>;
  position(): Promise<Point>;
}

export class UnavailableMouseBackend implements MouseBackend {
  readonly name = "unavailable";

  private fail(op: string): never {
    throw new FluxError({
      code: "E_PLATFORM_UNSUPPORTED",
      message: `Mouse.${op} requires an input-injection backend (Python bridge SendInput or a native addon)`,
      hint: "Wire a real MouseBackend once dependencies are installed; FluxAgent will not fake pointer events.",
    });
  }

  async move(): Promise<void> {
    this.fail("move");
  }
  async down(): Promise<void> {
    this.fail("down");
  }
  async up(): Promise<void> {
    this.fail("up");
  }
  async click(): Promise<void> {
    this.fail("click");
  }
  async doubleClick(): Promise<void> {
    this.fail("doubleClick");
  }
  async scroll(): Promise<void> {
    this.fail("scroll");
  }
  async position(): Promise<Point> {
    this.fail("position");
  }
}

export class MouseController {
  private backend: MouseBackend;

  constructor(backend: MouseBackend = new UnavailableMouseBackend()) {
    this.backend = backend;
  }

  move(p: Point): Promise<void> {
    return this.backend.move(p);
  }
  click(opts?: ClickOptions): Promise<void> {
    return this.backend.click(opts);
  }
  doubleClick(opts?: ClickOptions): Promise<void> {
    return this.backend.doubleClick(opts);
  }
  rightClick(opts?: Omit<ClickOptions, "button">): Promise<void> {
    return this.backend.click({ ...opts, button: "right" });
  }
  scroll(opts: ScrollOptions): Promise<void> {
    return this.backend.scroll(opts);
  }
  position(): Promise<Point> {
    return this.backend.position();
  }

  setBackend(backend: MouseBackend): void {
    this.backend = backend;
  }
}
