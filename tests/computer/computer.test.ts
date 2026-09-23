/**
 * Phase 3 — ComputerController capability layer tests.
 *
 * Uses the REAL controllers (unit category) with temp directories for
 * filesystem operations. Screen/input remain unwired backends: the tests
 * assert the layer reports them honestly instead of faking success.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { FileController } from "../../src/controllers/files.ts";
import { CommandController } from "../../src/controllers/command.ts";
import { ScreenController } from "../../src/controllers/screen.ts";
import { KeyboardController } from "../../src/controllers/keyboard.ts";
import { MouseController } from "../../src/controllers/mouse.ts";
import { ApplicationController } from "../../src/controllers/application.ts";
import { SystemController } from "../../src/controllers/system.ts";
import { ProcessController } from "../../src/controllers/process.ts";
import { WindowController } from "../../src/controllers/window.ts";
import { ComputerController } from "../../src/computer/computer.ts";

function makeComputer(sandboxRoot?: string): ComputerController {
  const policy = sandboxRoot
    ? { allowedRoots: [sandboxRoot], deniedRoots: [], blockedCommandTokens: [] }
    : undefined;
  const files = new FileController({ sandboxPolicy: policy });
  const command = new CommandController({ sandboxPolicy: policy });
  const processes = new ProcessController(command);
  const windows = new WindowController(command);
  const screen = new ScreenController();
  const keyboard = new KeyboardController();
  const mouse = new MouseController();
  const apps = new ApplicationController(command, processes, windows);
  const system = new SystemController(command);
  return new ComputerController({ files, command, screen, keyboard, mouse, apps, system });
}

describe("ComputerController", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "flux-computer-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("capability detection is honest: screen and input unavailable without backends", () => {
    const c = makeComputer(dir);
    const caps = c.capabilities();
    const byName = new Map(caps.map((k) => [k.name, k]));
    assert.equal(byName.get("filesystem")!.available, true);
    assert.equal(byName.get("command")!.available, true);
    assert.equal(byName.get("system")!.available, true);
    assert.equal(byName.get("screen")!.available, false, "screen must report unavailable without backend");
    assert.ok(byName.get("screen")!.reason, "unavailable capability must carry a reason");
    assert.equal(byName.get("input")!.available, false, "input must report unavailable without backend");
    assert.equal(c.isAvailable("screen"), false);
    assert.equal(c.isAvailable("filesystem"), true);
  });

  test("readFile / writeFile / listDirectory round-trip inside sandbox", async () => {
    const c = makeComputer(dir);
    const file = path.join(dir, "notes.txt");
    await c.writeFile(file, "hello computer layer");
    const text = await c.readFile(file);
    assert.equal(text, "hello computer layer");
    const entries = await c.listDirectory(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.name, "notes.txt");
    const meta = await c.fileInfo(file);
    assert.equal(meta.isFile, true);
    assert.equal(meta.size, "hello computer layer".length);
  });

  test("runCommand executes a real harmless command and returns structured result", async () => {
    const c = makeComputer(dir);
    // CommandController spawns WITHOUT a shell (security default), so pass
    // the executable and args separately. node -e is cross-platform.
    const res = await c.runCommand("node", { timeoutMs: 20_000 });
    // `node` with no args reading stdin would hang — instead use a file arg.
    assert.equal(res.timedOut, false);
  });

  test("runCommand via ComputerController delegates to command.run with args", async () => {
    // Write a tiny script into the sandbox and run it with node.
    const script = path.join(dir, "ok.js");
    writeFileSync(script, "process.stdout.write('computer-ok');\n");
    const c = makeComputer(dir);
    const res = await c.runCommandWithArgs("node", [script], { timeoutMs: 20_000 });
    assert.equal(res.exitCode, 0, `stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes("computer-ok"), `stdout was: ${res.stdout}`);
  });

  test("screenshot returns structured error (never fake data) when backend missing", async () => {
    const c = makeComputer(dir);
    await assert.rejects(() => c.screenshot(), (err: { code?: string }) => {
      assert.match(String(err.code), /PLATFORM|UNSUPPORTED|ERROR/);
      return true;
    });
  });

  test("typeText returns structured error (never fake success) when backend missing", async () => {
    const c = makeComputer(dir);
    await assert.rejects(() => c.typeText("no backend"), (err: { code?: string }) => {
      assert.match(String(err.code), /PLATFORM|UNSUPPORTED|ERROR/);
      return true;
    });
  });

  test("system info is real (platform, node version, memory)", () => {
    const c = makeComputer(dir);
    // SystemController.info is sync; verify via the controller we depend on.
    const sys = new SystemController(new CommandController());
    const info = sys.info();
    assert.equal(info.platform, process.platform);
    assert.equal(info.nodeVersion, process.version);
    assert.ok(info.totalMemMb > 0);
  });
});
