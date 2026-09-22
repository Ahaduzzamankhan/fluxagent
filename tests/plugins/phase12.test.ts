/**
 * Phase 12 tests: plugin manifest validation, lifecycle state machine,
 * permission clamping to the ceiling, namespacing, and unload.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "../../src/tools/registry.ts";
import { EventBus } from "../../src/events/event-bus.ts";
import type { Tool } from "../../src/tools/tool.ts";
import {
  PluginManager,
  InMemoryPluginStorage,
  PLUGIN_API_VERSION,
  type FluxPlugin,
} from "../../src/plugins/plugin-manager.ts";
import type { Logger } from "../../src/utils/logger.ts";

const silentLogger: Logger = {
  child: () => silentLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

function makeTool(name: string, level: "READ_ONLY" | "SAFE_WRITE" | "USER_CONFIRMATION" | "PRIVILEGED"): Tool {
  return {
    metadata: {
      name,
      description: `test tool ${name}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      permissionLevel: level,
      tags: [],
    },
    validate: (_args: unknown) => {},
    execute: async () => ({ ok: true, output: "done" }),
  } as unknown as Tool;
}

function makePlugin(name: string, opts: { tools?: Tool[]; disposed?: () => void } = {}): FluxPlugin {
  return {
    manifest: {
      name,
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      contributes: { tools: (opts.tools ?? []).map((t) => ({ name: t.metadata.name, description: "x", permissionLevel: "SAFE_WRITE", create: "default" })) },
    },
    initialize: async () => {},
    contributeTools: () => opts.tools ?? [],
    dispose: async () => opts.disposed?.(),
  };
}

test("plugins: valid manifest passes discovery and reaches validated state", () => {
  const manager = new PluginManager({
    registry: new ToolRegistry({ sessionId: "t" }),
    eventBus: new EventBus(),
    storage: new InMemoryPluginStorage("test"),
    permissionCeiling: "SAFE_WRITE",
    logger: silentLogger,
  });
  const record = manager.discover(
    { name: "greeter", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, contributes: {} },
    makePlugin("greeter"),
  );
  assert.equal(record.state, "validated");
  assert.equal(manager.list().length, 1);
});

test("plugins: invalid manifests are rejected with a reason", () => {
  const manager = new PluginManager({
    registry: new ToolRegistry({ sessionId: "t" }),
    eventBus: new EventBus(),
    storage: new InMemoryPluginStorage("test"),
    permissionCeiling: "SAFE_WRITE",
    logger: silentLogger,
  });
  const badName = manager.discover({ name: "BAD NAME!", version: "1.0.0", apiVersion: "1", contributes: {} }, makePlugin("x"));
  assert.equal(badName.state, "rejected");
  assert.match(badName.error ?? "", /name/);

  const badVersion = manager.discover({ name: "ok", version: "not-semver", apiVersion: "1", contributes: {} }, makePlugin("x"));
  assert.equal(badVersion.state, "rejected");

  const wrongApi = manager.discover({ name: "ok", version: "1.0.0", apiVersion: "999", contributes: {} }, makePlugin("x"));
  assert.equal(wrongApi.state, "rejected");
  assert.match(wrongApi.error ?? "", /incompatible/);
});

test("plugins: enable initializes, registers namespaced tools, clamps permissions", async () => {
  const registry = new ToolRegistry({ sessionId: "t" });
  const manager = new PluginManager({
    registry,
    eventBus: new EventBus(),
    storage: new InMemoryPluginStorage("test"),
    permissionCeiling: "SAFE_WRITE",
    logger: silentLogger,
  });
  manager.discover(
    { name: "risky", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, contributes: {} },
    makePlugin("risky", { tools: [makeTool("erase-everything", "PRIVILEGED"), makeTool("peek", "READ_ONLY")] }),
  );
  const record = await manager.enable("risky");
  assert.equal(record.state, "enabled");

  const clamped = registry.get("plugin.risky.erase-everything");
  assert.ok(clamped, "namespaced tool registered");
  assert.equal(clamped!.metadata.permissionLevel, "SAFE_WRITE", "PRIVILEGED clamped to ceiling");
  assert.ok(clamped!.metadata.tags.includes("plugin:risky"));

  const untouched = registry.get("plugin.risky.peek");
  assert.equal(untouched!.metadata.permissionLevel, "READ_ONLY", "below-ceiling level preserved");
});

test("plugins: lifecycle state machine rejects illegal transitions", async () => {
  const manager = new PluginManager({
    registry: new ToolRegistry({ sessionId: "t" }),
    eventBus: new EventBus(),
    storage: new InMemoryPluginStorage("test"),
    permissionCeiling: "SAFE_WRITE",
    logger: silentLogger,
  });
  await assert.rejects(() => manager.enable("nope"), /unknown plugin/);

  manager.discover(
    { name: "p", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, contributes: {} },
    makePlugin("p"),
  );
  await manager.enable("p");
  await assert.rejects(() => manager.enable("p"), /cannot enable/);

  await manager.disable("p");
  await assert.rejects(() => manager.disable("p"), /cannot disable/);
  // re-enable from disabled is legal
  const again = await manager.enable("p");
  assert.equal(again.state, "enabled");
});

test("plugins: unload disposes and removes; duplicate names rejected", async () => {
  let disposed = 0;
  const manager = new PluginManager({
    registry: new ToolRegistry({ sessionId: "t" }),
    eventBus: new EventBus(),
    storage: new InMemoryPluginStorage("test"),
    permissionCeiling: "SAFE_WRITE",
    logger: silentLogger,
  });
  manager.discover(
    { name: "dup", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, contributes: {} },
    makePlugin("dup"),
  );
  const second = manager.discover(
    { name: "dup", version: "2.0.0", apiVersion: PLUGIN_API_VERSION, contributes: {} },
    makePlugin("dup2"),
  );
  assert.equal(second.state, "rejected", "duplicate name rejected");

  manager.discover(
    { name: "gone", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, contributes: {} },
    makePlugin("gone", { disposed: () => { disposed++; } }),
  );
  await manager.enable("gone");
  await manager.unload("gone");
  assert.equal(disposed, 1);
  assert.equal(manager.get("gone"), undefined);
  assert.equal(manager.list().length, 1);
});
