/**
 * FluxAgent — window controller.
 *
 * Window enumeration/focus/close on Windows via PowerShell (stdlib path,
 * no native deps). Implementation stays isolated; the agent only sees typed
 * results.
 */

import { PlatformUnsupportedError } from "../utils/errors.ts";
import type { CommandController } from "./command.ts";

export interface WindowInfo {
  /** OS window handle (hwnd as decimal string). */
  readonly handle: string;
  readonly title: string;
  readonly processName?: string;
  readonly pid?: number;
}

export class WindowNotFoundError extends Error {
  constructor(hint: string) {
    super(`Window not found: ${hint}`);
    this.name = "WindowNotFoundError";
  }
}

const ENUM_SCRIPT = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static List<string> Enumerate() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (sb.Length > 0) list.Add(h.ToInt64() + "|" + sb.ToString() + "|" + pid);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
[WinEnum]::Enumerate() | ForEach-Object { $_ }
`.trim();

export class WindowController {
  private readonly command: CommandController;
  private readonly platform: NodeJS.Platform;

  constructor(command: CommandController, platform: NodeJS.Platform = process.platform) {
    this.command = command;
    this.platform = platform;
  }

  private assertWindows(op: string): void {
    if (this.platform !== "win32") throw new PlatformUnsupportedError(op, this.platform);
  }

  async listWindows(): Promise<WindowInfo[]> {
    this.assertWindows("window.list");
    const res = await this.command.run({
      command: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", ENUM_SCRIPT],
      timeoutMs: 15_000,
    });
    if (res.exitCode !== 0) {
      throw new Error(`window enumeration failed: ${res.stderr.slice(0, 400)}`);
    }
    return parseWindowLines(res.stdout);
  }

  async findWindows(titleSubstring: string): Promise<WindowInfo[]> {
    const wins = await this.listWindows();
    const needle = titleSubstring.toLowerCase();
    return wins.filter((w) => w.title.toLowerCase().includes(needle));
  }

  async focus(handle: string): Promise<void> {
    this.assertWindows("window.focus");
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$h = [IntPtr]::new(${Number(handle)})
[WinFocus]::ShowWindow($h, 9) | Out-Null
[WinFocus]::SetForegroundWindow($h)
`.trim();
    const res = await this.command.run({
      command: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      timeoutMs: 10_000,
    });
    if (res.exitCode !== 0) throw new WindowNotFoundError(`handle ${handle}`);
  }

  async close(handle: string): Promise<void> {
    this.assertWindows("window.close");
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinClose {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);
}
"@
$h = [IntPtr]::new(${Number(handle)})
[WinClose]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
`.trim();
    const res = await this.command.run({
      command: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      timeoutMs: 10_000,
    });
    if (res.exitCode !== 0) throw new WindowNotFoundError(`handle ${handle}`);
  }
}

/** Parse "hwnd|title|pid" lines. Exported for tests. */
export function parseWindowLines(output: string): WindowInfo[] {
  const out: WindowInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("|");
    const handle = parts[0];
    const pidRaw = parts[2];
    if (!handle) continue;
    const pid = pidRaw ? Number.parseInt(pidRaw, 10) : NaN;
    out.push({
      handle,
      title: parts.slice(1, parts.length - (parts.length > 2 ? 1 : 0)).join("|") || trimmed,
      ...(Number.isInteger(pid) ? { pid } : {}),
    });
  }
  return out;
}
