/**
 * Controller tests — interface-level, no real OS mutation:
 *   - sandbox path/command policy (pure)
 *   - tasklist CSV parsing (pure)
 *   - window enumeration line parsing (pure)
 *   - command controller on a real harmless command
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkPathAllowed,
  checkCommandAllowed,
  isInsideRoot,
  canonicalPath,
  DEFAULT_SANDBOX_POLICY,
} from "../../src/security/sandbox.ts";
import { parseTasklist } from "../../src/controllers/process.ts";
import { parseWindowLines } from "../../src/controllers/window.ts";
import { CommandController } from "../../src/controllers/command.ts";

test("sandbox denies Windows system roots and honors allowlist", () => {
  const policy = {
    ...DEFAULT_SANDBOX_POLICY,
    allowedRoots: ["C:\\Work"],
    deniedRoots: ["C:\\Windows"],
  };
  assert.throws(() => checkPathAllowed("C:\\Windows\\system32\\x", policy));
  assert.throws(() => checkPathAllowed("C:\\Users\\someone\\x", policy), /Path not allowed/);
  checkPathAllowed("C:\\Work\\sub\\file.txt", policy);
  assert.ok(isInsideRoot("c:\\work\\a", "C:\\Work\\"), "case/slash insensitive");
  assert.equal(canonicalPath("C:/Work"), "c:\\work\\");
});

test("command policy blocks dangerous tokens", () => {
  const res1 = checkCommandAllowed("cmd", ["/c", "format", "C:"], DEFAULT_SANDBOX_POLICY);
  assert.equal(res1.allowed, false);
  const res2 = checkCommandAllowed("git", ["status"], DEFAULT_SANDBOX_POLICY);
  assert.equal(res2.allowed, true);
});

test("parseTasklist handles CSV output", () => {
  const csv = `"notepad.exe","1234","Console","1","12,345 K"
"explorer.exe","567","Console","1","98,765 K"`;
  const procs = parseTasklist(csv);
  assert.equal(procs.length, 2);
  assert.equal(procs[0]!.pid, 1234);
  assert.equal(procs[0]!.name, "notepad.exe");
  assert.equal(procs[0]!.memoryKb, 12345);
});

test("parseWindowLines handles hwnd|title|pid", () => {
  const lines = "12345|Notepad - readme.txt|99\n6789|Settings|42";
  const wins = parseWindowLines(lines);
  assert.equal(wins.length, 2);
  assert.equal(wins[0]!.handle, "12345");
  assert.equal(wins[0]!.title, "Notepad - readme.txt");
  assert.equal(wins[0]!.pid, 99);
});

test("command controller runs a real harmless command with output", async () => {
  const cmd = new CommandController({ defaultTimeoutMs: 10_000 });
  const res = await cmd.run({ command: process.execPath, args: ["-e", "console.log('flux-ok')"] });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /flux-ok/);
  assert.equal(res.timedOut, false);
});
