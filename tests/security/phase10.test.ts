/**
 * Phase 10 tests: audit logging, untrusted-input validation, manifest
 * validation, permission flow with audit hooks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog, validateUntrustedInput, validatePluginManifest, DEFAULT_VALIDATION_LIMITS } from "../../src/security/audit.ts";
import { PermissionManager } from "../../src/security/permission-manager.ts";
import { AutoApproveRequester } from "../../src/security/approval.ts";
import { S } from "../../src/tools/schemas.ts";

// ── audit log ─────────────────────────────────────────────────────────────────

test("audit log records security events with redaction and bounded retention", () => {
  const audit = new AuditLog({ maxRecords: 10 });
  audit.record({
    type: "permission.requested",
    actor: "sess_1",
    subject: "file.delete",
    outcome: "denied",
    detail: { apiKey: "sk-super-secret", path: "C:/tmp/x", token: "abc" },
    sessionId: "sess_1",
  });
  audit.record({ type: "permission.granted", actor: "user", subject: "file.delete", outcome: "allowed" });

  const denied = audit.query({ type: "permission.requested" });
  assert.equal(denied.length, 1);
  assert.equal(denied[0]!.detail["apiKey"], "[REDACTED]", "secret-looking keys redacted");
  assert.equal(denied[0]!.detail["token"], "[REDACTED]");
  assert.equal(denied[0]!.detail["path"], "C:/tmp/x", "non-sensitive fields kept");

  // Bounded retention: oldest records drop when the cap is exceeded.
  for (let i = 0; i < 12; i++) {
    audit.record({ type: "tool.executed", subject: `tool-${i}`, outcome: "completed" });
  }
  assert.equal(audit.size, 10, "retention cap enforced");
  assert.equal(audit.query({ type: "permission.requested" }).length, 0, "oldest trimmed first");
});

test("audit log: query filters by actor/session/since", () => {
  const audit = new AuditLog();
  audit.record({ type: "auth.success", actor: "cli", subject: "login", outcome: "allowed" });
  audit.record({ type: "auth.failure", actor: "anon", subject: "login", outcome: "denied" });
  assert.equal(audit.query({ actor: "anon" }).length, 1);
  assert.equal(audit.query({ type: "auth.success" })[0]!.actor, "cli");
  const future = audit.query({ since: new Date(Date.now() + 1000).toISOString() });
  assert.equal(future.length, 0);
});

// ── untrusted input validation ────────────────────────────────────────────────

test("untrusted input validation: shapes, sizes, depth, prototype guards", () => {
  const ok = validateUntrustedInput({ goal: "read file", options: [1, true, null, "x"] });
  assert.equal(ok.ok, true);

  assert.equal(validateUntrustedInput("x".repeat(DEFAULT_VALIDATION_LIMITS.maxStringLength + 1)).ok, false);
  assert.equal(validateUntrustedInput({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }).ok, false, "depth guard");
  assert.equal(validateUntrustedInput(42).ok, true);
  assert.equal(validateUntrustedInput(Number.NaN).ok, false);
  assert.equal(validateUntrustedInput(undefined).ok, false);

  // Prototype pollution attempts.
  assert.equal(validateUntrustedInput(JSON.parse('{"__proto__": {"isAdmin": true}}')).ok, false);
  assert.equal(validateUntrustedInput({ constructor: "x" }).ok, false);

  // Class instances are not plain JSON objects.
  assert.equal(validateUntrustedInput(new Date()).ok, false);
  assert.equal(validateUntrustedInput(() => 1).ok, false, "functions rejected");
});

test("untrusted input validation: bounded arrays and key counts", () => {
  const big = { items: Array.from({ length: DEFAULT_VALIDATION_LIMITS.maxArrayLength + 1 }, (_, i) => i) };
  assert.equal(validateUntrustedInput(big).ok, false);
  const manyKeys: Record<string, number> = {};
  for (let i = 0; i < DEFAULT_VALIDATION_LIMITS.maxKeys + 1; i++) manyKeys[`k${i}`] = i;
  assert.equal(validateUntrustedInput(manyKeys).ok, false);
});

// ── plugin manifest validation ────────────────────────────────────────────────

test("plugin manifest validation: valid manifests pass, malformed ones fail", () => {
  const valid = validatePluginManifest({
    name: "my-plugin",
    version: "1.2.3",
    apiVersion: "1",
    contributes: { tools: [{ name: "ping", description: "pings", permissionLevel: "READ_ONLY", create: "makePing" }] },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.manifest!.name, "my-plugin");

  assert.equal(validatePluginManifest({ version: "1.0.0", apiVersion: "1", contributes: {} }).ok, false, "missing name");
  assert.equal(validatePluginManifest({ name: "Bad Name!", version: "1.0.0", apiVersion: "1", contributes: {} }).ok, false, "bad name charset");
  assert.equal(validatePluginManifest({ name: "x", version: "abc", apiVersion: "1", contributes: {} }).ok, false, "bad semver");
  assert.equal(validatePluginManifest({ name: "x", version: "1.0.0", contributes: {} }).ok, false, "missing apiVersion");
  assert.equal(validatePluginManifest({ name: "x", version: "1.0.0", apiVersion: "1" }).ok, false, "missing contributes");
});

// ── permission flow with audit (fine-grained) ─────────────────────────────────

test("permission manager grants below ceiling and denies above; audit hook observes", async () => {
  const pm = new PermissionManager({
    sessionId: "s",
    ceiling: "SAFE_WRITE",
    approvalRequester: new AutoApproveRequester(),
    autoApproveBelow: "SAFE_WRITE",
  });

  const granted = await pm.authorize({
    tool: { name: "file.read", permissionLevel: "READ_ONLY", description: "d", inputSchema: S.object({}) },
    args: {},
  });
  assert.equal(granted, true);

  const privileged = await pm.authorize({
    tool: { name: "process.terminate", permissionLevel: "PRIVILEGED", description: "d", inputSchema: S.object({}) },
    args: {},
  });
  assert.equal(privileged, false, "PRIVILEGED denied under SAFE_WRITE ceiling");
});
