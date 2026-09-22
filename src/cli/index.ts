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
  readonly flags: ReadonlySet<string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Set<string>();
  let command = "help";
  let first = true;
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      flags.add(arg.slice(2).toLowerCase());
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
  return { command, positional, flags };
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
  run "<goal>"      Run one goal (mock provider; deterministic, offline)
  doctor [--json]   Health diagnostics (node, config, sandbox, storage, python)
  tools             List registered tools
  models            List routed model descriptors
  config [file]     Show redacted effective configuration
  version           Print core/api/plugin versions
  help              This message

Examples:
  fluxagent doctor
  fluxagent run "read the file notes.txt"
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
  const { command, positional, flags } = parseArgs(argv);
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
    case "help":
    default:
      printHelp();
      return;
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/cli/index.ts")) {
  main();
}
