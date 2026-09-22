/**
 * FluxAgent — built-in command/process tools.
 *
 * The agent can only request these named tools; the CommandController keeps
 * the actual spawn mechanics + policy. Arbitrary JS execution does not exist.
 */

import { S, validateAgainstSchema, type JSONSchema } from "../schemas.ts";
import { defineTool, type Tool } from "../tool.ts";
import type { CommandController } from "../../controllers/command.ts";
import type { ProcessController } from "../../controllers/process.ts";

const runArgs = S.object(
  {
    command: S.string("Executable to run (no shell operators)"),
    args: S.array(S.string("Argument"), "Argument list"),
    cwd: S.string("Working directory"),
    timeoutMs: S.integer("Timeout in ms (default from controller)"),
  },
  ["command"],
);

const listArgs = S.object({ nameFilter: S.string("Filter by image name, e.g. notepad.exe") });
const startArgs = S.object(
  {
    executable: S.string("Executable path"),
    args: S.array(S.string("Argument"), "Argument list"),
    cwd: S.string("Working directory"),
    detached: S.boolean("Keep running after agent exits (default true)"),
  },
  ["executable"],
);
const killArgs = S.object({ pid: S.integer("Process id"), force: S.boolean("Force termination") }, ["pid"]);
const inspectArgs = S.object({ pid: S.integer("Process id") }, ["pid"]);

function validated<T>(schema: JSONSchema, args: unknown): asserts args is T {
  const res = validateAgainstSchema<T>(schema, args);
  if (!res.valid) throw new Error(res.issues.join("; "));
}

export function createCommandTools(command: CommandController): Tool[] {
  const run = defineTool({
    metadata: {
      name: "command.run",
      description:
        "Run an executable with an argument list (no shell), capture stdout/stderr/exit code. Policy-checked.",
      inputSchema: runArgs,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["command"],
    },
    validate(args: unknown): asserts args is { command: string; args?: string[]; cwd?: string; timeoutMs?: number } {
      validated(runArgs, args);
    },
    async execute(args, ctx) {
      command.check({ command: args.command, args: args.args }); // policy pre-check
      const res = await command.run({
        command: args.command,
        args: args.args ?? [],
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        ...(ctx.signal ? {} : {}),
      });
      return {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: res.timedOut,
        durationMs: res.durationMs,
      };
    },
  });

  return [run];
}

export function createProcessTools(processes: ProcessController): Tool[] {
  const list = defineTool({
    metadata: {
      name: "process.list",
      description: "List running processes (Windows tasklist).",
      inputSchema: listArgs,
      permissionLevel: "READ_ONLY",
      tags: ["process"],
    },
    validate(args: unknown): asserts args is { nameFilter?: string } {
      validated(listArgs, args);
    },
    async execute(args) {
      const procs = await processes.listProcesses(args.nameFilter);
      return { count: procs.length, processes: procs.slice(0, 200) };
    },
  });

  const start = defineTool({
    metadata: {
      name: "process.start",
      description: "Start a process by executable path.",
      inputSchema: startArgs,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["process"],
    },
    validate(args: unknown): asserts args is { executable: string; args?: string[]; cwd?: string; detached?: boolean } {
      validated(startArgs, args);
    },
    async execute(args) {
      const info = await processes.start({
        executable: args.executable,
        args: args.args,
        cwd: args.cwd,
        detached: args.detached,
      });
      return { pid: info.pid, name: info.name };
    },
  });

  const terminate = defineTool({
    metadata: {
      name: "process.terminate",
      description: "Terminate a process by PID.",
      inputSchema: killArgs,
      permissionLevel: "PRIVILEGED",
      tags: ["process", "destructive"],
    },
    validate(args: unknown): asserts args is { pid: number; force?: boolean } {
      validated(killArgs, args);
    },
    async execute(args) {
      await processes.terminate(args.pid, { force: args.force });
      return { pid: args.pid, terminated: true };
    },
  });

  const inspect = defineTool({
    metadata: {
      name: "process.inspect",
      description: "Inspect one process by PID.",
      inputSchema: inspectArgs,
      permissionLevel: "READ_ONLY",
      tags: ["process"],
    },
    validate(args: unknown): asserts args is { pid: number } {
      validated(inspectArgs, args);
    },
    async execute(args) {
      return processes.inspect(args.pid);
    },
  });

  return [list, start, terminate, inspect];
}
