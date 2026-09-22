/**
 * PermissionManager tests: ceiling enforcement, auto-approve band, scripted
 * approval flow, remembered decisions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { PermissionManager } from "../../src/security/permission-manager.ts";
import { ScriptedApprovals } from "../helpers/mocks.ts";
import { EventBus } from "../../src/events/event-bus.ts";
import { permissionRank } from "../../src/tools/permissions.ts";
import type { ToolInfo } from "../../src/tools/tool.ts";

function toolInfo(name: string, level: ToolInfo["permissionLevel"]): ToolInfo {
  return {
    name,
    description: "test tool",
    inputSchema: { type: "object" },
    permissionLevel: level,
    tags: [],
  };
}

function manager(overrides: Partial<ConstructorParameters<typeof PermissionManager>[0]> = {}, approvals?: ScriptedApprovals) {
  const bus = new EventBus();
  const scripted = approvals ?? new ScriptedApprovals();
  const pm = new PermissionManager({
    sessionId: "sess-test",
    ceiling: "PRIVILEGED",
    approvalRequester: scripted,
    autoApproveBelow: "SAFE_WRITE",
    ...overrides,
    eventBus: bus,
  });
  return { pm, scripted, bus };
}

test("READ_ONLY and SAFE_WRITE auto-approved by default", async () => {
  const { pm } = manager();
  assert.equal(await pm.authorize({ tool: toolInfo("file.read", "READ_ONLY"), args: {} }), true);
  assert.equal(await pm.authorize({ tool: toolInfo("file.write", "SAFE_WRITE"), args: {} }), true);
});

test("USER_CONFIRMATION requires approval; scripted deny blocks", async () => {
  const approvals = new ScriptedApprovals().deny("command.run");
  const { pm } = manager({}, approvals);
  assert.equal(await pm.authorize({ tool: toolInfo("command.run", "USER_CONFIRMATION"), args: {} }), false);
  assert.equal(approvals.requests.length, 1);
});

test("scripted approve allows and remembered decisions skip re-prompt", async () => {
  const approvals = new ScriptedApprovals().approve("app.launch");
  const { pm } = manager({}, approvals);
  assert.equal(await pm.authorize({ tool: toolInfo("app.launch", "USER_CONFIRMATION"), args: {} }), true);
  assert.equal(await pm.authorize({ tool: toolInfo("app.launch", "USER_CONFIRMATION"), args: {} }), true);
  assert.equal(approvals.requests.length, 1, "second call must reuse the remembered decision");
});

test("ceiling blocks PRIVILEGED tools when ceiling is USER_CONFIRMATION", async () => {
  const { pm } = manager({ ceiling: "USER_CONFIRMATION" });
  assert.equal(await pm.authorize({ tool: toolInfo("process.terminate", "PRIVILEGED"), args: {} }), false);
});

test("permission rank ordering matches spec", () => {
  assert.ok(permissionRank("READ_ONLY") < permissionRank("SAFE_WRITE"));
  assert.ok(permissionRank("SAFE_WRITE") < permissionRank("USER_CONFIRMATION"));
  assert.ok(permissionRank("USER_CONFIRMATION") < permissionRank("PRIVILEGED"));
});
