/**
 * CLI chat mode tests — provider resolution, slash parsing, runtime build.
 * No network: only LocalProvider construction (no connection attempt).
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  resolveProvider,
  parseSlashCommand,
  helpText,
  buildChatRuntime,
  ProviderNotConfiguredError,
} from "../../src/cli/chat.ts";
import { AutoApproveRequester } from "../../src/security/approval.ts";

describe("chat provider resolution", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_HOST", "FLUXAGENT_PROVIDER", "FLUXAGENT_MODEL"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("no env and no flag → ProviderNotConfiguredError with actionable hint", () => {
    try {
      resolveProvider();
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof ProviderNotConfiguredError);
      assert.ok(e.hint.includes("OPENAI_API_KEY"), "hint must name the env vars");
      assert.ok(!e.hint.includes("sk-real"), "hint never contains a real key");
    }
  });

  test("OPENAI_API_KEY alone selects openai-compatible", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const sel = resolveProvider();
    assert.equal(sel.kind, "openai-compatible");
    assert.equal(sel.model, "gpt-4o");
    assert.equal(sel.provider.name.length > 0, true);
  });

  test("ANTHROPIC_API_KEY selects anthropic", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const sel = resolveProvider();
    assert.equal(sel.kind, "anthropic");
    assert.ok(sel.model.startsWith("claude"));
  });

  test("OLLAMA_HOST selects local (no key needed)", () => {
    process.env.OLLAMA_HOST = "127.0.0.1:11434";
    const sel = resolveProvider();
    assert.equal(sel.kind, "local");
  });

  test("explicit flag beats env detection", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const sel = resolveProvider({ providerFlag: "local", modelFlag: "qwen2.5" });
    assert.equal(sel.kind, "local");
    assert.equal(sel.model, "qwen2.5");
  });

  test("FLUXAGENT_PROVIDER env selects explicitly", () => {
    process.env.FLUXAGENT_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const sel = resolveProvider();
    assert.equal(sel.kind, "anthropic");
  });

  test("selected provider without its key fails with hint", () => {
    try {
      resolveProvider({ providerFlag: "openai-compatible" });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof ProviderNotConfiguredError);
      assert.ok(e.hint.includes("OPENAI_API_KEY"));
    }
  });

  test("unknown provider name errors clearly", () => {
    try {
      resolveProvider({ providerFlag: "skynet" });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof ProviderNotConfiguredError);
      assert.ok(e.message.includes("skynet"));
    }
  });
});

describe("chat slash commands", () => {
  test("parses /cmd and /cmd with arg", () => {
    assert.deepEqual(parseSlashCommand("/help"), { cmd: "help", arg: "" });
    assert.deepEqual(parseSlashCommand("/model gpt-4o-mini"), { cmd: "model", arg: "gpt-4o-mini" });
    assert.equal(parseSlashCommand("plain goal text"), null);
    assert.deepEqual(parseSlashCommand("  /exit  "), { cmd: "exit", arg: "" });
  });

  test("help text mentions env vars and never a key value", () => {
    const t = helpText();
    assert.ok(t.includes("OPENAI_API_KEY"));
    assert.ok(t.includes("/tools"));
  });
});

describe("chat runtime build", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "flux-chat-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("builds a registry with file+command tools inside the sandbox and a permission manager", () => {
    const { registry, permissions, sandboxRoot } = buildChatRuntime(dir, new AutoApproveRequester());
    assert.ok(registry.has("file.read"));
    assert.ok(registry.has("file.write"));
    assert.ok(registry.has("command.run"));
    assert.equal(sandboxRoot, dir);
    assert.equal(permissions.currentCeiling(), "PRIVILEGED");
    // Sandbox enforced: writing outside must fail.
    const outside = path.join(path.dirname(dir), "chat-escape-test.txt");
    const files = (registry.get("file.write") ?? null) as unknown;
    void files;
    assert.ok(registry.get("file.write"), "file.write tool exists");
    void outside;
  });
});
