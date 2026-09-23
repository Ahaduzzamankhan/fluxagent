/**
 * FluxAgent — interactive chat mode (`fluxagent chat`).
 *
 * A Claude-Code-style terminal session: bring your own API key, type a goal,
 * watch the agent call real tools, approve sensitive actions in the terminal.
 *
 *   - Provider resolution: --provider flag or FLUXAGENT_PROVIDER env, falling
 *     back to the standard env keys (OPENAI_API_KEY / ANTHROPIC_API_KEY /
 *     OLLAMA_HOST). Keys never print.
 *   - Every model tool call flows through the ToolCallingLoop → registry →
 *     PermissionManager with the console approval prompt.
 *   - Slash commands: /help /tools /providers /skills /exit /quit /clear.
 *   - Zero dependencies: readline from node:.
 */

import * as readline from "node:readline";
import * as path from "node:path";

import { ToolCallingLoop } from "../agent/tool-calling.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { PermissionManager } from "../security/permission-manager.ts";
import { ConsoleApprovalRequester, type ApprovalRequester } from "../security/approval.ts";
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from "../security/sandbox.ts";
import { FileController } from "../controllers/files.ts";
import { CommandController } from "../controllers/command.ts";
import { ProcessController } from "../controllers/process.ts";
import { WindowController } from "../controllers/window.ts";
import { ScreenController } from "../controllers/screen.ts";
import { KeyboardController } from "../controllers/keyboard.ts";
import { MouseController } from "../controllers/mouse.ts";
import { ApplicationController } from "../controllers/application.ts";
import { SystemController } from "../controllers/system.ts";
import { createFileTools } from "../tools/builtin/file-tools.ts";
import { createCommandTools, createProcessTools } from "../tools/builtin/command-tools.ts";
import { createSystemTools } from "../tools/builtin/screen-tools.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { OpenAiCompatibleProvider } from "../llm/providers/openai-compatible.ts";
import { AnthropicProvider } from "../llm/providers/anthropic.ts";
import { LocalProvider } from "../llm/providers/local.ts";

// ─── Provider resolution ─────────────────────────────────────────────────────

export interface ProviderSelection {
  readonly provider: LlmProvider;
  readonly kind: string;
  readonly model: string;
}

export interface ChatOptions {
  readonly providerFlag?: string;
  readonly modelFlag?: string;
  readonly baseUrlFlag?: string;
  readonly cwd?: string;
  readonly approvalRequester?: ApprovalRequester;
  readonly maxTurns?: number;
}

export class ProviderNotConfiguredError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "ProviderNotConfiguredError";
    this.hint = hint;
  }
}

/**
 * Resolve which provider to use, in priority order:
 *   1. --provider flag
 *   2. FLUXAGENT_PROVIDER env
 *   3. presence of OPENAI_API_KEY / ANTHROPIC_API_KEY / OLLAMA_HOST
 * Never echoes the key itself.
 */
export function resolveProvider(options: ChatOptions = {}): ProviderSelection {
  const wanted = (options.providerFlag ?? process.env.FLUXAGENT_PROVIDER ?? "").toLowerCase();
  const modelFlag = options.modelFlag ?? process.env.FLUXAGENT_MODEL;
  const baseUrlFlag = options.baseUrlFlag ?? process.env.FLUXAGENT_BASE_URL;

  const pick = (kind: string): ProviderSelection => {
    switch (kind) {
      case "openai":
      case "openai-compatible":
      case "openai_compatible": {
        const key = process.env.OPENAI_API_KEY;
        if (!key) {
          throw new ProviderNotConfiguredError(
            "OpenAI-compatible provider selected but OPENAI_API_KEY is not set",
            "export OPENAI_API_KEY=sk-…  (key stays in your environment; it is never printed)",
          );
        }
        const baseUrl = baseUrlFlag ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
        const model = modelFlag ?? "gpt-4o";
        return {
          provider: new OpenAiCompatibleProvider({
            id: "openai-compatible",
            baseUrl,
            apiKey: key,
            defaultModel: model,
            timeoutMs: 120_000,
          }),
          kind: "openai-compatible",
          model,
        };
      }
      case "anthropic": {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) {
          throw new ProviderNotConfiguredError(
            "Anthropic provider selected but ANTHROPIC_API_KEY is not set",
            "export ANTHROPIC_API_KEY=sk-ant-…  (key stays in your environment; it is never printed)",
          );
        }
        const model = modelFlag ?? "claude-sonnet-4-20250514";
        return {
          provider: new AnthropicProvider({
            id: "anthropic",
            apiKey: key,
            defaultModel: model,
            timeoutMs: 120_000,
          }),
          kind: "anthropic",
          model,
        };
      }
      case "local":
      case "ollama": {
        const baseUrl = baseUrlFlag ?? process.env.OLLAMA_HOST
          ? (baseUrlFlag ?? `http://${(process.env.OLLAMA_HOST ?? "127.0.0.1:11434").replace(/^https?:\/\//, "")}`)
          : "http://127.0.0.1:11434";
        const model = modelFlag ?? "llama3.1";
        return {
          provider: new LocalProvider({
            id: "local",
            baseUrl,
            defaultModel: model,
            timeoutMs: 300_000,
          }),
          kind: "local",
          model,
        };
      }
      default:
        throw new ProviderNotConfiguredError(
          `Unknown provider "${kind}". Use openai-compatible, anthropic, or local.`,
          "fluxagent chat --provider openai-compatible",
        );
    }
  };

  if (wanted) return pick(wanted);
  if (process.env.OPENAI_API_KEY) return pick("openai-compatible");
  if (process.env.ANTHROPIC_API_KEY) return pick("anthropic");
  if (process.env.OLLAMA_HOST) return pick("local");
  throw new ProviderNotConfiguredError(
    "No provider configured",
    [
      "Set one of these environment variables:",
      "  export OPENAI_API_KEY=sk-…          (OpenAI or any /v1/chat/completions API)",
      "  export ANTHROPIC_API_KEY=sk-ant-…   (Anthropic)",
      "  export OLLAMA_HOST=127.0.0.1:11434  (local Ollama, no key needed)",
      "",
      "Or: fluxagent chat --provider local --model llama3.1",
    ].join("\n"),
  );
}

// ─── Sandbox + tools for chat ────────────────────────────────────────────────

export function buildChatRuntime(cwd: string, approvalRequester: ApprovalRequester): {
  registry: ToolRegistry;
  permissions: PermissionManager;
  sandboxRoot: string;
} {
  const sandboxRoot = cwd;
  const policy: SandboxPolicy = {
    ...DEFAULT_SANDBOX_POLICY,
    allowedRoots: [sandboxRoot],
  };
  const files = new FileController({ sandboxPolicy: policy });
  const command = new CommandController({ sandboxPolicy: policy });
  const processes = new ProcessController(command);
  const windows = new WindowController(command);
  const screen = new ScreenController();
  const keyboard = new KeyboardController();
  const mouse = new MouseController();
  const apps = new ApplicationController(command, processes, windows);
  const system = new SystemController(command);

  const registry = new ToolRegistry({ sessionId: "chat" });
  registry.registerAll(createFileTools(files));
  registry.registerAll(createCommandTools(command));
  registry.registerAll(createProcessTools(processes));
  registry.registerAll(createSystemTools(system, apps));
  void screen; void keyboard; void mouse; // wired when backends exist

  const permissions = new PermissionManager({
    sessionId: "chat",
    ceiling: "PRIVILEGED",
    approvalRequester,
    autoApproveBelow: "SAFE_WRITE",
  });
  return { registry, permissions, sandboxRoot };
}

// ─── Slash commands ──────────────────────────────────────────────────────────

export function parseSlashCommand(input: string): { cmd: string; arg: string } | null {
  const t = input.trim();
  if (!t.startsWith("/")) return null;
  const spaceIdx = t.indexOf(" ");
  const cmd = spaceIdx === -1 ? t.slice(1) : t.slice(1, spaceIdx);
  const arg = spaceIdx === -1 ? "" : t.slice(spaceIdx + 1).trim();
  return { cmd: cmd.toLowerCase(), arg };
}

export function helpText(): string {
  return [
    "Commands:",
    "  <goal>        Run the agent on your goal (it will use tools and ask approval)",
    "  /tools        List available tools",
    "  /providers    Show which provider is active (never shows the key)",
    "  /skills       List skills",
    "  /clear        Clear conversation (new session)",
    "  /exit, /quit  Leave chat (or Ctrl+C)",
    "",
    "Environment:",
    "  OPENAI_API_KEY / ANTHROPIC_API_KEY / OLLAMA_HOST  pick the provider",
    "  FLUXAGENT_PROVIDER / FLUXAGENT_MODEL / FLUXAGENT_BASE_URL  override defaults",
  ].join("\n");
}

// ─── Chat session ────────────────────────────────────────────────────────────

export async function runChat(options: ChatOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const { blue, green, yellow, dim, red } = colors();

  let selection: ProviderSelection;
  try {
    selection = resolveProvider(options);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      console.error(red(`\nerror: ${err.message}`));
      console.error(dim(err.hint) + "\n");
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log(`FluxAgent chat — provider: ${blue(selection.kind)}  model: ${blue(selection.model)}`);
  console.log(dim(`sandbox: ${cwd}   (file/command tools operate inside this directory)`));
  console.log(dim("type a goal, or /help for commands\n"));

  const { registry, permissions } = buildChatRuntime(cwd, options.approvalRequester ?? new ConsoleApprovalRequester());

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  let running = true;
  while (running) {
    let input: string;
    try {
      input = await ask(green("› "));
    } catch {
      break; // EOF / Ctrl+C
    }
    const slash = parseSlashCommand(input);
    if (slash) {
      switch (slash.cmd) {
        case "help":
          console.log(dim(helpText()));
          break;
        case "tools": {
          const tools = registry.list();
          console.log(`${tools.length} tools:`);
          for (const t of tools) console.log(`  ${t.name.padEnd(28)} ${t.permissionLevel}`);
          break;
        }
        case "providers":
          console.log(`active: ${selection.kind} (${selection.model}) — key in env, never displayed`);
          break;
        case "skills": {
          const { builtinSkills } = await import("../skills/skill.ts");
          for (const s of builtinSkills()) console.log(`  ${s.name.padEnd(18)} ${s.description}`);
          break;
        }
        case "clear":
          console.clear();
          break;
        case "exit":
        case "quit":
          running = false;
          break;
        default:
          console.log(yellow(`unknown command /${slash.cmd} — try /help`));
      }
      continue;
    }
    if (!input.trim()) continue;

    const goal = input.trim();
    console.log(dim("… thinking (the agent will ask before anything sensitive)\n"));
    const loop = new ToolCallingLoop();
    try {
      const result = await loop.run({
        goal,
        registry,
        permissions,
        provider: selection.provider,
        maxTurns: options.maxTurns ?? 24,
      });
      if (result.text) {
        console.log(`\n${result.text}\n`);
      }
      if (result.status === "max_turns") {
        console.log(yellow(`\n[stopped: turn budget of ${options.maxTurns ?? 24} reached — ask a narrower goal]\n`));
      }
      const failed = result.steps.filter((s) => !s.ok);
      if (failed.length > 0) {
        console.log(dim(`(${failed.length} tool call(s) failed or were denied along the way)`));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red(`\nrun failed: ${msg}\n`));
    }
  }
  rl.close();
  console.log(dim("bye"));
}

function colors(): { blue: (s: string) => string; green: (s: string) => string; yellow: (s: string) => string; dim: (s: string) => string; red: (s: string) => string } {
  const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    blue: wrap("36"),
    green: wrap("32"),
    yellow: wrap("33"),
    red: wrap("31"),
    dim: wrap("2"),
  };
}

export const CHAT_DEFAULTS = { cwd: path.resolve("."), maxTurns: 24 };
