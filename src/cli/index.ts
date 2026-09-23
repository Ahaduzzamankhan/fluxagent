/**
 * FluxAgent — CLI.
 *
 * A thin, dependency-free command surface over the SAME public runtime API
 * other clients use (`createRuntime`, `runDoctor`, `MockLlmProvider`).
 * No core logic lives here: commands compose runtime capabilities and print.
 *
 * Commands:
 *   fluxagent version            — print versions (core, api, plugin-api)
 *   fluxagent doctor [--json]    — health diagnostics
 *   fluxagent tools              — list registered tools
 *   fluxagent models             — list routed model descriptors
 *   fluxagent config             — show redacted, effective config
 *   fluxagent run "<goal>"       — run one goal (mock provider by default)
 *   fluxagent help               — this message
 */

import * as path from "node:path";

const FLUX_VERSION = "0.2.0";

interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  /** Boolean flags (--json) and valued flags (--provider openai → "openai"). */
  readonly flags: ReadonlySet<string>;
  readonly flagValues: ReadonlyMap<string, string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Set<string>();
  const flagValues = new Map<string, string>();
  /** Flags that take a value argument. */
  const VALUED = new Set(["provider", "model", "base-url", "config"]);
  let command = "help";
  let first = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2).toLowerCase();
      if (VALUED.has(name) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        flagValues.set(name, argv[i + 1]!);
        i++; // consume the value
      } else {
        flags.add(name);
      }
      continue;
    }
    if (first) {
      command = arg;
      first = false;
      continue;
    }
    positional.push(arg);
  }
  if (first) command = argv.includes("help") ? "help" : command;
  return { command, positional, flags, flagValues };
}

function printTools(): void {
  void (async () => {
    const { createRuntime } = await import("../index.ts");
    const { MockLlmProvider } = await import("../llm/mock-provider.ts");
    const runtime = createRuntime({ provider: new MockLlmProvider() });
    const tools = runtime.registry.list();
    console.log(`${tools.length} tools registered:\n`);
    for (const tool of tools) {
      console.log(`  ${tool.name.padEnd(28)} ${tool.permissionLevel.padEnd(18)} ${tool.description}`);
    }
    console.log(`\nDiscovery profiles: ${runtime.discovery.profiles().length} tool capability profiles.`);
  })().catch(fail);
}

function printModels(): void {
  void (async () => {
    const { createRuntime } = await import("../index.ts");
    const { MockLlmProvider } = await import("../llm/mock-provider.ts");
    const runtime = createRuntime({ provider: new MockLlmProvider() });
    const models = runtime.modelRouter.listModels();
    console.log(`${models.length} model descriptor(s):\n`);
    for (const m of models) {
      console.log(`  ${m.id}  provider=${m.provider}  capabilities=[${m.capabilities.join(", ")}]  ctx=${m.contextWindowTokens}`);
    }
  })().catch(fail);
}

function printConfig(configFile?: string): void {
  void (async () => {
    const { loadConfig, describeConfig } = await import("../runtime/config.ts");
    const config = await loadConfig(configFile ?? path.join(process.cwd(), "config", "default.json"));
    // describeConfig never echoes secret-like values (see config.ts).
    console.log(JSON.stringify(describeConfig(config), null, 2));
  })().catch(fail);
}

function printDoctor(asJson: boolean, configFile?: string): void {
  void (async () => {
    const { runDoctor, formatDoctorReport } = await import("../runtime/doctor.ts");
    const report = await runDoctor(configFile ? { configFile } : {});
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    process.exitCode = report.healthy ? 0 : 1;
  })().catch(fail);
}

function runGoal(goal: string): void {
  void (async () => {
    const { createRuntime } = await import("../index.ts");
    const { MockLlmProvider } = await import("../llm/mock-provider.ts");
    console.log(`[run] goal: ${goal}`);
    console.log("[run] provider: mock (deterministic; no network, no keys)\n");
    const runtime = createRuntime({ provider: new MockLlmProvider() });
    const session = runtime.createSession({ goal });
    const result = await session.agent.run(goal);
    console.log(`status:    ${result.status}`);
    console.log(`summary:   ${result.summary}`);
    console.log(`steps:     ${result.stepsCompleted} completed, ${result.stepsFailed} failed`);
    console.log(`sessionId: ${session.id}`);
    await session.end("cli-run-done");
  })().catch(fail);
}

function printProviders(asJson: boolean): void {
  void (async () => {
    const { createRuntime } = await import("../index.ts");
    const { MockLlmProvider } = await import("../llm/mock-provider.ts");
    const runtime = createRuntime({ provider: new MockLlmProvider() });
    const providers = runtime.listProviders();
    if (asJson) {
      console.log(JSON.stringify(providers, null, 2));
      return;
    }
    console.log(`${providers.length} provider(s):\n`);
    for (const p of providers) {
      console.log(`  ${p.id}  kind=${p.kind}  key=${p.hasApiKey ? "configured" : "none"}  models=[${p.models.join(", ")}]`);
    }
    console.log("\nBYOK providers (openai-compatible / anthropic / local) are configured per-environment;");
    console.log("API keys are read from env vars and never printed.");
  })().catch(fail);
}

function printSkills(asJson: boolean): void {
  void (async () => {
    const { createRuntime } = await import("../index.ts");
    const { MockLlmProvider } = await import("../llm/mock-provider.ts");
    const runtime = createRuntime({ provider: new MockLlmProvider() });
    const skills = runtime.listSkills();
    if (asJson) {
      console.log(JSON.stringify(skills, null, 2));
      return;
    }
    console.log(`${skills.length} skill(s):\n`);
    for (const s of skills) {
      const status = s.ready ? "ready" : `missing tools: ${s.missingTools.join(", ")}`;
      console.log(`  ${s.name.padEnd(18)} v${s.version}  ${status}\n    ${s.description}`);
    }
  })().catch(fail);
}

function printSessions(asJson: boolean): void {
  void (async () => {
    // Sessions are per-runtime; the CLI creates an ephemeral runtime, so this
    // lists persisted checkpoints (resumable sessions) instead.
    const { JsonFileCheckpointStore } = await import("../runtime/checkpoint.ts");
    const { loadConfig } = await import("../runtime/config.ts");
    const config = await loadConfig(path.join(process.cwd(), "config", "default.json"));
    void config;
    const store = new JsonFileCheckpointStore(path.join(process.cwd(), ".fluxagent", "checkpoints"));
    // list() is per-session; without a session id, show the directory contents.
    const { promises: fs } = await import("node:fs");
    let ids: string[] = [];
    try {
      ids = (await fs.readdir(path.join(process.cwd(), ".fluxagent", "checkpoints")))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      ids = [];
    }
    if (asJson) {
      console.log(JSON.stringify({ checkpoints: ids }, null, 2));
      return;
    }
    if (ids.length === 0) {
      console.log("No saved checkpoints. Runs checkpoint automatically; paused runs appear here.");
      return;
    }
    console.log(`${ids.length} checkpoint(s):\n`);
    for (const id of ids) console.log(`  ${id}`);
    console.log("\nResume with: fluxagent resume <checkpoint-id>");
  })().catch(fail);
}

function resumeSession(checkpointId: string, asJson: boolean): void {
  void (async () => {
    const { JsonFileCheckpointStore } = await import("../runtime/checkpoint.ts");
    const { SessionPauseResume } = await import("../runtime/resume.ts");
    const store = new JsonFileCheckpointStore(path.join(process.cwd(), ".fluxagent", "checkpoints"));
    const svc = new SessionPauseResume({ store });
    try {
      const state = await svc.resume(checkpointId);
      if (asJson) {
        console.log(JSON.stringify({ resumed: true, checkpointId, goal: state.goal, stepCount: state.stepCount }, null, 2));
        return;
      }
      console.log(`resumed checkpoint ${checkpointId}`);
      console.log(`  goal:      ${state.goal}`);
      console.log(`  steps so far: ${state.stepCount}`);
      console.log("\nNote: permission grants from the original session are NOT restored —");
      console.log("the runtime re-asks before any sensitive action.");
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  })().catch(fail);
}

function printVersion(): void {
  void (async () => {
    const { PLUGIN_API_VERSION } = await import("../plugins/plugin-manager.ts");
    const { API_VERSION } = await import("../api/http-server.ts");
    console.log(`fluxagent core:   ${FLUX_VERSION}`);
    console.log(`api version:      ${API_VERSION}`);
    console.log(`plugin api:       ${PLUGIN_API_VERSION}`);
    console.log(`node:             ${process.version}`);
    console.log(`platform:         ${process.platform}`);
  })().catch(fail);
}

function printHelp(): void {
  console.log(`FluxAgent ${FLUX_VERSION} — modular AI agent runtime

Usage: fluxagent <command> [args]

Commands:
  chat              Interactive agent session with your own API key
                    (--provider openai-compatible|anthropic|local, --model, --base-url)
  run "<goal>"      Run one goal (mock provider; deterministic, offline)
  doctor [--json]   Health diagnostics (node, config, sandbox, storage, python)
  tools             List registered tools
  models            List routed model descriptors
  providers [--json] List model providers (no secrets shown)
  skills [--json]   List skills and readiness
  sessions [--json] List saved checkpoints
  resume <id>       Resume a paused/crashed session from a checkpoint
  config [file]     Show redacted effective configuration
  version           Print core/api/plugin versions
  help              This message

Examples:
  fluxagent doctor
  fluxagent run "read the file notes.txt"
  fluxagent skills
  fluxagent sessions
  fluxagent config
`);
}

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`error: ${message}`);
  process.exitCode = 1;
  throw err;
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const { command, positional, flags, flagValues } = parseArgs(argv);
  switch (command) {
    case "version":
      printVersion();
      return;
    case "doctor":
      printDoctor(flags.has("json"), positional[0]);
      return;
    case "tools":
      printTools();
      return;
    case "models":
      printModels();
      return;
    case "providers":
      printProviders(flags.has("json"));
      return;
    case "skills":
      printSkills(flags.has("json"));
      return;
    case "sessions":
      printSessions(flags.has("json"));
      return;
    case "resume": {
      const id = positional[0];
      if (!id) {
        console.error("error: usage: fluxagent resume <checkpoint-id>");
        process.exitCode = 1;
        return;
      }
      resumeSession(id, flags.has("json"));
      return;
    }
    case "config":
      printConfig(positional[0]);
      return;
    case "run": {
      const goal = positional.join(" ").trim();
      if (!goal) {
        console.error('error: usage: fluxagent run "<goal>"');
        process.exitCode = 1;
        return;
      }
      runGoal(goal);
      return;
    }
    case "chat": {
      void (async () => {
        const { runChat } = await import("./chat.ts");
        await runChat({
          providerFlag: flagValues.get("provider"),
          modelFlag: flagValues.get("model"),
          baseUrlFlag: flagValues.get("base-url"),
        });
      })().catch(fail);
      return;
    }
    case "help":
    default:
      printHelp();
      return;
  }
}

// Run as CLI when executed directly, OR when launched through any bin shim
// (bin/fluxagent.mjs, bin/fluxagent.cmd, bin/fluxagent.ps1, npm link) — all
// of which end up importing this module with "fluxagent" in the argv path.
const argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (argv1.endsWith("src/cli/index.ts") || /bin[\\/]fluxagent\.(mjs|cmd|ps1)$/.test(argv1) || argv1.endsWith("fluxagent")) {
  main();
}
