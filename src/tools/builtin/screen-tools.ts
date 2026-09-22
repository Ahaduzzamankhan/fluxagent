/**
 * FluxAgent — built-in screen/input/system tools.
 *
 * Screen + input capabilities report actionable "backend unavailable" errors
 * until a real backend (Python bridge or native addon) is wired — no fake
 * screenshots or fake input.
 */

import { S, validateAgainstSchema, type JSONSchema } from "../schemas.ts";
import { defineTool, type Tool } from "../tool.ts";
import type { ScreenController } from "../../controllers/screen.ts";
import type { KeyboardController } from "../../controllers/keyboard.ts";
import type { MouseController } from "../../controllers/mouse.ts";
import type { SystemController } from "../../controllers/system.ts";
import type { ApplicationController } from "../../controllers/application.ts";

function validated<T>(schema: JSONSchema, args: unknown): asserts args is T {
  const res = validateAgainstSchema<T>(schema, args);
  if (!res.valid) throw new Error(res.issues.join("; "));
}

export function createScreenTools(screen: ScreenController): Tool[] {
  const dims = S.object({});

  const shotArgs = S.object(
    { monitor: S.integer("Monitor index (0 = primary)") },
    [],
  );

  const dimensions = defineTool({
    metadata: {
      name: "screen.dimensions",
      description: "Get screen size and monitor layout.",
      inputSchema: dims,
      permissionLevel: "READ_ONLY",
      tags: ["screen"],
    },
    validate(args: unknown): asserts args is Record<string, never> {
      validated(dims, args);
    },
    async execute() {
      return screen.getDimensions();
    },
  });

  const capture = defineTool({
    metadata: {
      name: "screen.screenshot",
      description: "Capture a monitor screenshot as PNG (requires a capture backend).",
      inputSchema: shotArgs,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["screen"],
    },
    validate(args: unknown): asserts args is { monitor?: number } {
      validated(shotArgs, args);
    },
    async execute(args) {
      const shot = await screen.screenshot(args.monitor ?? 0);
      return {
        width: shot.width,
        height: shot.height,
        monitor: shot.monitor,
        bytes: shot.data.byteLength,
        capturedAt: shot.capturedAt,
        note: "PNG bytes are held in-memory; a file output tool can persist them",
      };
    },
  });

  const monitors = defineTool({
    metadata: {
      name: "screen.monitors",
      description: "List connected monitors.",
      inputSchema: dims,
      permissionLevel: "READ_ONLY",
      tags: ["screen"],
    },
    validate(args: unknown): asserts args is Record<string, never> {
      validated(dims, args);
    },
    async execute() {
      const list = await screen.listMonitors();
      return { count: list.length, monitors: list };
    },
  });

  return [dimensions, capture, monitors];
}

export function createInputTools(keyboard: KeyboardController, mouse: MouseController): Tool[] {
  const typeArgs = S.object({ text: S.string("Text to type", { minLength: 1 }), intervalMs: S.integer("Delay between keys (ms)") }, ["text"]);
  const pressArgs = S.object(
    { key: S.string("Key name, e.g. Enter, F5, a"), modifiers: S.array(S.enum(["ctrl", "alt", "shift", "win"], "Modifier"), "Held modifiers") },
    ["key"],
  );
  const hotkeyArgs = S.object({ keys: S.array(S.string("Key"), "Keys pressed together", { minLength: 1 }) }, ["keys"]);
  const clickArgs = S.object(
    { x: S.number("X coordinate"), y: S.number("Y coordinate"), button: S.enum(["left", "right", "middle"], "Button") },
    [],
  );
  const scrollArgs = S.object(
    { deltaX: S.number("Horizontal scroll"), deltaY: S.number("Vertical scroll"), x: S.number("X position"), y: S.number("Y position") },
    [],
  );

  const type = defineTool({
    metadata: {
      name: "keyboard.type",
      description: "Type text into the focused window (requires input backend).",
      inputSchema: typeArgs,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["input"],
    },
    validate(args: unknown): asserts args is { text: string; intervalMs?: number } {
      validated(typeArgs, args);
    },
    async execute(args) {
      await keyboard.typeText(args.text, { intervalMs: args.intervalMs });
      return { typed: args.text.length };
    },
  });

  const press = defineTool({
    metadata: {
      name: "keyboard.press",
      description: "Press a key (optionally with modifiers).",
      inputSchema: pressArgs,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["input"],
    },
    validate(args: unknown): asserts args is { key: string; modifiers?: ("ctrl" | "alt" | "shift" | "win")[] } {
      validated(pressArgs, args);
    },
    async execute(args) {
      await keyboard.pressKey({ key: args.key, modifiers: args.modifiers });
      return { pressed: args.key };
    },
  });

  const hotkey = defineTool({
    metadata: {
      name: "keyboard.hotkey",
      description: "Press a key combination, e.g. ctrl+shift+Escape.",
      inputSchema: hotkeyArgs,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["input"],
    },
    validate(args: unknown): asserts args is { keys: string[] } {
      validated(hotkeyArgs, args);
    },
    async execute(args) {
      await keyboard.hotkey(args.keys);
      return { hotkey: args.keys.join("+") };
    },
  });

  const move = defineTool({
    metadata: {
      name: "mouse.move",
      description: "Move the mouse pointer.",
      inputSchema: S.object({ x: S.number("X"), y: S.number("Y") }, ["x", "y"]),
      permissionLevel: "USER_CONFIRMATION",
      tags: ["input"],
    },
    validate(args: unknown): asserts args is { x: number; y: number } {
      validated(S.object({ x: S.number("X"), y: S.number("Y") }, ["x", "y"]), args);
    },
    async execute(args) {
      await mouse.move({ x: args.x, y: args.y });
      return { x: args.x, y: args.y };
    },
  });

  const click = defineTool({
    metadata: {
      name: "mouse.click",
      description: "Click at coordinates (defaults: left button, current position).",
      inputSchema: clickArgs,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["input"],
    },
    validate(args: unknown): asserts args is { x?: number; y?: number; button?: "left" | "right" | "middle" } {
      validated(clickArgs, args);
    },
    async execute(args) {
      const point = args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : undefined;
      if (args.button === "right") await mouse.rightClick(point ? { point } : undefined);
      else if (args.button === "middle" && point) await mouse.click({ point, button: "middle" });
      else await mouse.click(point ? { point } : undefined);
      return { clicked: true, ...(point ? { at: point } : {}), button: args.button ?? "left" };
    },
  });

  const dbl = defineTool({
    metadata: {
      name: "mouse.doubleClick",
      description: "Double-click at coordinates.",
      inputSchema: clickArgs,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["input"],
    },
    validate(args: unknown): asserts args is { x?: number; y?: number; button?: "left" | "right" | "middle" } {
      validated(clickArgs, args);
    },
    async execute(args) {
      const point = args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : undefined;
      await mouse.doubleClick(point ? { point } : undefined);
      return { doubleClicked: true };
    },
  });

  const scroll = defineTool({
    metadata: {
      name: "mouse.scroll",
      description: "Scroll the wheel (positive deltaY scrolls down).",
      inputSchema: scrollArgs,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["input"],
    },
    validate(args: unknown): asserts args is { deltaX?: number; deltaY?: number; x?: number; y?: number } {
      validated(scrollArgs, args);
    },
    async execute(args) {
      await mouse.scroll({ deltaX: args.deltaX, deltaY: args.deltaY, ...(args.x !== undefined && args.y !== undefined ? { at: { x: args.x, y: args.y } } : {}) });
      return { scrolled: true };
    },
  });

  return [type, press, hotkey, move, click, dbl, scroll];
}

export function createSystemTools(system: SystemController, apps: ApplicationController): Tool[] {
  const info = defineTool({
    metadata: {
      name: "system.info",
      description: "Host info: OS, CPU, memory, versions.",
      inputSchema: S.object({}),
      permissionLevel: "READ_ONLY",
      tags: ["system"],
    },
    validate(args: unknown): asserts args is Record<string, never> {
      validated(S.object({}), args);
    },
    async execute() {
      return system.info();
    },
  });

  const disks = defineTool({
    metadata: {
      name: "system.disks",
      description: "List filesystem drives.",
      inputSchema: S.object({}),
      permissionLevel: "READ_ONLY",
      tags: ["system"],
    },
    validate(args: unknown): asserts args is Record<string, never> {
      validated(S.object({}), args);
    },
    async execute() {
      return { drives: await system.disks() };
    },
  });

  const appDetect = defineTool({
    metadata: {
      name: "app.detect",
      description: "Detect whether an application is running (by exe name or window title).",
      inputSchema: S.object({ name: S.string("Executable or window title") }, ["name"]),
      permissionLevel: "READ_ONLY",
      tags: ["application"],
    },
    validate(args: unknown): asserts args is { name: string } {
      validated(S.object({ name: S.string("Executable or window title") }, ["name"]), args);
    },
    async execute(args) {
      return { name: args.name, running: await apps.detect(args.name) };
    },
  });

  const appLaunch = defineTool({
    metadata: {
      name: "app.launch",
      description: "Launch an application by path or start-menu alias.",
      inputSchema: S.object(
        { executable: S.string("Executable path or alias"), args: S.array(S.string("Argument"), "Launch arguments") },
        ["executable"],
      ),
      permissionLevel: "USER_CONFIRMATION",
      tags: ["application"],
    },
    validate(args: unknown): asserts args is { executable: string; args?: string[] } {
      validated(S.object({ executable: S.string("Executable path or alias"), args: S.array(S.string("Argument"), "Launch arguments") }, ["executable"]), args);
    },
    async execute(args) {
      const res = await apps.launch(args.executable, { args: args.args });
      return res;
    },
  });

  const appClose = defineTool({
    metadata: {
      name: "app.close",
      description: "Close an application by window title or process name.",
      inputSchema: S.object({ name: S.string("Title or process name"), force: S.boolean("Force kill") }, ["name"]),
      permissionLevel: "PRIVILEGED",
      tags: ["application", "destructive"],
    },
    validate(args: unknown): asserts args is { name: string; force?: boolean } {
      validated(S.object({ name: S.string("Title or process name"), force: S.boolean("Force kill") }, ["name"]), args);
    },
    async execute(args) {
      await apps.close(args.name, { force: args.force });
      return { closed: args.name };
    },
  });

  return [info, disks, appDetect, appLaunch, appClose];
}
