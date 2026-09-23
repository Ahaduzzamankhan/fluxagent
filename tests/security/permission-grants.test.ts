/**
 * Phase 5 — permission grant model tests.
 * allow-once / allow-session / allow-tool, expiry, ceiling, audit.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { PermissionManager } from "../../src/security/permission-manager.ts";
import type { ApprovalRequester, ApprovalRequest, ApprovalDecision } from "../../src/security/approval.ts";
import type { ToolInfo } from "../../src/tools/tool.ts";

function toolInfo(name: string, level: ToolInfo["permissionLevel"]): ToolInfo {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {}, required: [] },
    permissionLevel: level,
    tags: [],
  };
}

/** Requester that prompts once with a scripted decision, then fails the test if asked again. */
function scriptedRequester(decision: (req: ApprovalRequest, call: number) => ApprovalDecision): ApprovalRequester & { calls: ApprovalRequest[] } {
  const state = { calls: [] as ApprovalRequest[] };
  return {
    get calls() {
      return state.calls;
    },
    async request(req: ApprovalRequest) {
      state.calls.push(req);
      return decision(req, state.calls.length);
    },
  };
}

const NEVER: ApprovalRequester = {
  async request() {
    throw new Error("must not prompt when a grant covers the call");
  },
};

describe("PermissionManager grants (Phase 5)", () => {
  const PRIVILEGED = toolInfo("test.privileged", "PRIVILEGED");
  const CONFIRM = toolInfo("test.confirm", "USER_CONFIRMATION");

  function manager(requester: ApprovalRequester, ceiling: ToolInfo["permissionLevel"] = "PRIVILEGED") {
    return new PermissionManager({
      sessionId: "s1",
      ceiling,
      approvalRequester: requester,
      autoApproveBelow: "SAFE_WRITE",
    });
  }

  test("allow-once grants exactly one call, then prompts again", async () => {
    const req = scriptedRequester(() => ({ requestId: "r", approved: true }));
    const pm = manager(req);
    pm.grant("test.privileged", "once", "PRIVILEGED");

    assert.equal(await pm.authorize({ tool: PRIVILEGED, args: {} }), true, "first call covered by once-grant");
    assert.equal(req.calls.length, 0, "no prompt for granted call");

    // Once-grant consumed: a second call needs approval (auto-deny here would
    // also be fine — we script an approval to prove prompting resumes).
    assert.equal(await pm.authorize({ tool: PRIVILEGED, args: {} }), true);
    assert.equal(req.calls.length, 1, "second call must prompt");
  });

  test("allow-session covers repeated calls without prompting", async () => {
    const pm = manager(NEVER);
    pm.grant("test.privileged", "session", "PRIVILEGED");
    for (let i = 0; i < 3; i++) {
      assert.equal(await pm.authorize({ tool: PRIVILEGED, args: {} }), true, `call ${i}`);
    }
  });

  test("expired session grant falls back to prompting (auto-deny = safe stop)", async () => {
    const deny = scriptedRequester(() => ({ requestId: "r", approved: false, reason: "expired grant, user says no" }));
    const pm = manager(deny);
    pm.grant("test.privileged", "session", "PRIVILEGED", { expiresAt: Date.now() - 1 });

    assert.equal(await pm.authorize({ tool: PRIVILEGED, args: {} }), false, "expired grant must not authorize");
    assert.equal(deny.calls.length, 1, "must fall back to the approval flow");
  });

  test("ceiling still denies granted tools (grants never beat the ceiling)", async () => {
    const pm = manager(NEVER, "SAFE_WRITE");
    pm.grant("test.privileged", "session", "PRIVILEGED");
    assert.equal(await pm.authorize({ tool: PRIVILEGED, args: {} }), false, "ceiling is absolute");
  });

  test("grant scoped below the requested level does not authorize", async () => {
    const pm = manager(NEVER);
    pm.grant("test.privileged", "session", "SAFE_WRITE"); // weaker grant
    // SAFE_WRITE grant can't cover a PRIVILEGED tool; with auto-deny fallback:
    const denyPm = new PermissionManager({
      sessionId: "s1",
      ceiling: "PRIVILEGED",
      approvalRequester: { async request() { return { requestId: "r", approved: false }; } },
      autoApproveBelow: "SAFE_WRITE",
    });
    denyPm.grant("test.privileged", "session", "SAFE_WRITE");
    assert.equal(await denyPm.authorize({ tool: PRIVILEGED, args: {} }), false);
  });

  test("revoke() removes active grants immediately", async () => {
    const deny = scriptedRequester(() => ({ requestId: "r", approved: false }));
    const pm = manager(deny);
    pm.grant("test.privileged", "session", "PRIVILEGED");
    assert.equal(await pm.authorize({ tool: PRIVILEGED, args: {} }), true);
    assert.equal(pm.revoke("test.privileged"), 1);
    assert.equal(await pm.authorize({ tool: PRIVILEGED, args: {} }), false, "revoked grant must not authorize");
  });

  test("audit trail records grant, denial and ceiling outcomes", async () => {
    const pm = manager(NEVER, "USER_CONFIRMATION");
    pm.grant("test.confirm", "session", "USER_CONFIRMATION");
    await pm.authorize({ tool: CONFIRM, args: {} });
    await pm.authorize({ tool: PRIVILEGED, args: {} }); // above ceiling

    const trail = pm.auditTrail();
    const grantEntry = trail.find((e) => e.toolName === "test.confirm" && e.outcome === "granted");
    assert.ok(grantEntry, "grant decision must be audited");
    assert.equal(grantEntry!.why, "grant");
    const ceilingEntry = trail.find((e) => e.toolName === "test.privileged" && e.outcome === "denied");
    assert.ok(ceilingEntry, "ceiling denial must be audited");
    assert.equal(ceilingEntry!.why, "ceiling");
  });

  test("activeGrants() lists only valid grants", async () => {
    const pm = manager(NEVER);
    pm.grant("a", "session", "PRIVILEGED");
    pm.grant("b", "once", "PRIVILEGED");
    pm.grant("c", "session", "PRIVILEGED", { expiresAt: Date.now() - 5 });
    assert.deepEqual(pm.activeGrants().map((g) => g.toolName).sort(), ["a", "b"]);
  });
});
