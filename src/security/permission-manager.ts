/**
 * FluxAgent — permission enforcement.
 *
 * Phase 5 adds the grant model behind `authorize`:
 *
 *   grant scopes:   once | session | tool   (tool = "always allow this tool")
 *   grant expiry:   session grants may carry expiresAt (ms epoch)
 *   audit trail:    every decision is recorded (grant/deny + reason)
 *
 * Security invariants unchanged:
 *   - Session ceiling is absolute: nothing above it passes, whoever asks.
 *   - Only the runtime/user side can elevate (`elevate` is not exposed to the
 *     model surface); tools and model output cannot raise their own level.
 *   - Denied decisions with `remember` do not poison later explicit grants.
 */

import { Logger } from "../utils/logger.ts";
import type { EventBus } from "../events/event-bus.ts";
import { makeEvent } from "../events/events.ts";
import { ids } from "../utils/ids.ts";
import {
  permissionRank,
  type PermissionLevel,
} from "../tools/permissions.ts";
import type { ToolInfo } from "../tools/tool.ts";
import type {
  ApprovalRequester,
  ApprovalRequest,
} from "./approval.ts";
import { requestWithTimeout } from "./approval.ts";

export interface PermissionManagerOptions {
  readonly sessionId: string;
  /** Session ceiling: tools above this level are always denied. */
  readonly ceiling: PermissionLevel;
  readonly approvalRequester: ApprovalRequester;
  /** Tools at this level or below never require an approval prompt. */
  readonly autoApproveBelow: PermissionLevel;
  readonly approvalTimeoutMs?: number;
  readonly logger?: Logger;
  readonly eventBus?: EventBus;
}

/** Scope of a remembered grant. */
export type GrantScope = "once" | "session" | "tool";

/** An explicit grant (from a user/UI approval or runtime policy). */
export interface PermissionGrant {
  readonly id: string;
  readonly toolName: string;
  readonly scope: GrantScope;
  readonly level: PermissionLevel;
  /** Epoch ms after which a `session`-scope grant no longer applies. */
  readonly expiresAt?: number;
  readonly createdAt: number;
  /** Remaining uses for `once` grants. */
  usesLeft: number;
}

/** Audit record for every authorization decision. */
export interface PermissionAuditEntry {
  readonly at: string;
  readonly toolName: string;
  readonly level: PermissionLevel;
  readonly outcome: "granted" | "denied";
  readonly why: "ceiling" | "auto-approve" | "grant" | "user" | "expired" | "default";
  readonly grantId?: string;
  readonly reason?: string;
}

export class PermissionManager {
  private readonly sessionId: string;
  private ceiling: PermissionLevel;
  private readonly approvalRequester: ApprovalRequester;
  private readonly autoApproveBelow: PermissionLevel;
  private readonly approvalTimeoutMs: number;
  private readonly logger?: Logger;
  private readonly eventBus?: EventBus;
  /** Session-scoped remembered approvals keyed by tool name (legacy: booleans). */
  private readonly remembered = new Map<string, boolean>();
  /** Explicit grants, newest first. */
  private readonly grants: PermissionGrant[] = [];
  /** Audit trail (bounded). */
  private readonly audit: PermissionAuditEntry[] = [];
  private static readonly AUDIT_MAX = 500;

  constructor(options: PermissionManagerOptions) {
    this.sessionId = options.sessionId;
    this.ceiling = options.ceiling;
    this.approvalRequester = options.approvalRequester;
    this.autoApproveBelow = options.autoApproveBelow;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 0;
    this.logger = options.logger;
    this.eventBus = options.eventBus;
  }

  /**
   * Decide whether a tool call may proceed. Emits permission.* events.
   * Throws only on approval-timeout; denials return false.
   */
  async authorize(options: {
    tool: ToolInfo;
    args: Readonly<Record<string, unknown>>;
    runId?: string;
  }): Promise<boolean> {
    const { tool, args } = options;
    const level = tool.permissionLevel;

    // 1) Ceiling check — absolute.
    if (permissionRank(level) > permissionRank(this.ceiling)) {
      this.record({ toolName: tool.name, level, outcome: "denied", why: "ceiling", reason: `above session ceiling ${this.ceiling}` });
      this.eventBus?.emitSync(
        makeEvent(this.sessionId, "permission.denied", {
          toolName: tool.name, level,
          reason: `above session ceiling ${this.ceiling}`,
        }, options.runId),
      );
      return false;
    }

    // 2) Auto-approve low-risk levels.
    if (permissionRank(level) <= permissionRank(this.autoApproveBelow)) {
      this.record({ toolName: tool.name, level, outcome: "granted", why: "auto-approve" });
      this.eventBus?.emitSync(
        makeEvent(this.sessionId, "permission.granted", { toolName: tool.name, level }, options.runId),
      );
      return true;
    }

    // 3) Explicit grants (Phase 5): check before prompting.
    const grant = this.findValidGrant(tool.name, level);
    if (grant) {
      const allowed = this.consume(grant);
      if (allowed) {
        this.record({ toolName: tool.name, level, outcome: "granted", why: "grant", grantId: grant.id });
        this.eventBus?.emitSync(
          makeEvent(this.sessionId, "permission.granted", { toolName: tool.name, level }, options.runId),
        );
        return true;
      }
      // Grant was exhausted (once-scope) — fall through to prompting.
    }

    // 4) Remembered session decisions (legacy boolean memory).
    const memo = this.remembered.get(tool.name);
    if (memo !== undefined) {
      this.record(
        memo
          ? { toolName: tool.name, level, outcome: "granted", why: "user" }
          : { toolName: tool.name, level, outcome: "denied", why: "user", reason: "previously denied this session" },
      );
      this.eventBus?.emitSync(
        memo
          ? makeEvent(this.sessionId, "permission.granted", { toolName: tool.name, level }, options.runId)
          : makeEvent(this.sessionId, "permission.denied", {
              toolName: tool.name, level, reason: "previously denied this session",
            }, options.runId),
      );
      return memo;
    }

    // 5) Interactive approval.
    const request: ApprovalRequest = {
      requestId: ids.approval(),
      sessionId: this.sessionId,
      toolName: tool.name,
      level,
      action: this.describe(tool, args),
      argsPreview: args,
    };
    this.eventBus?.emitSync(
      makeEvent(this.sessionId, "permission.requested", { toolName: tool.name, level }, options.runId),
    );
    const decision = await requestWithTimeout(this.approvalRequester, request, this.approvalTimeoutMs);
    // Interactive decisions are remembered for the session by default so a
    // user approves a tool once, not on every call. `remember: false` opts out.
    if (decision.remember !== false) this.remembered.set(tool.name, decision.approved);
    this.record(
      decision.approved
        ? { toolName: tool.name, level, outcome: "granted", why: "user" }
        : { toolName: tool.name, level, outcome: "denied", why: "user", reason: decision.reason ?? "rejected by user" },
    );
    this.eventBus?.emitSync(
      decision.approved
        ? makeEvent(this.sessionId, "permission.granted", { toolName: tool.name, level }, options.runId)
        : makeEvent(this.sessionId, "permission.denied", {
            toolName: tool.name, level,
            reason: decision.reason ?? "rejected by user",
          }, options.runId),
    );
    return decision.approved;
  }

  // ── Phase 5: grant management (runtime/UI surface, never model-facing) ─────

  /**
   * Record an explicit grant. `once` allows exactly one call; `session` lasts
   * for the session (optionally bounded by expiresAt); `tool` lasts for the
   * session without expiry ("always allow").
   */
  grant(toolName: string, scope: GrantScope, level: PermissionLevel, options: { expiresAt?: number } = {}): PermissionGrant {
    const g: PermissionGrant = {
      id: ids.approval(),
      toolName,
      scope,
      level,
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      createdAt: Date.now(),
      usesLeft: scope === "once" ? 1 : Infinity,
    };
    this.grants.unshift(g);
    return g;
  }

  /** Revoke all grants (or just one tool's) — e.g. user changes their mind. */
  revoke(toolName?: string): number {
    let removed = 0;
    for (let i = this.grants.length - 1; i >= 0; i--) {
      const g = this.grants[i]!;
      if (toolName === undefined || g.toolName === toolName) {
        this.grants.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /** Active (non-expired, non-exhausted) grants, for UI display. */
  activeGrants(): readonly PermissionGrant[] {
    return this.grants.filter((g) => this.isValid(g));
  }

  /** Read-only audit trail. */
  auditTrail(): readonly PermissionAuditEntry[] {
    return [...this.audit];
  }

  /** Elevate the session ceiling (user/runtime only — not exposed to the model). */
  elevate(to: PermissionLevel): void {
    if (permissionRank(to) > permissionRank(this.ceiling)) {
      this.ceiling = to;
    }
  }

  currentCeiling(): PermissionLevel {
    return this.ceiling;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private findValidGrant(toolName: string, level: PermissionLevel): PermissionGrant | undefined {
    for (const g of this.grants) {
      if (g.toolName !== toolName || !this.isValid(g)) continue;
      if (permissionRank(level) <= permissionRank(g.level)) return g;
    }
    return undefined;
  }

  private isValid(g: PermissionGrant): boolean {
    if (g.scope === "once" && g.usesLeft <= 0) return false;
    if (g.expiresAt !== undefined && Date.now() >= g.expiresAt) return false;
    return true;
  }

  private consume(g: PermissionGrant): boolean {
    if (!this.isValid(g)) return false;
    if (g.scope === "once") g.usesLeft -= 1;
    return true;
  }

  private record(entry: PermissionAuditEntry): void {
    const full: PermissionAuditEntry = { at: new Date().toISOString(), ...entry };
    this.audit.unshift(full);
    if (this.audit.length > PermissionManager.AUDIT_MAX) this.audit.length = PermissionManager.AUDIT_MAX;
  }

  private describe(tool: ToolInfo, args: Readonly<Record<string, unknown>>): string {
    return `Run ${tool.name} with ${JSON.stringify(args)}`;
  }
}
