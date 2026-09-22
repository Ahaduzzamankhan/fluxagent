/**
 * FluxAgent — permission enforcement.
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

export class PermissionManager {
  private readonly sessionId: string;
  private ceiling: PermissionLevel;
  private readonly approvalRequester: ApprovalRequester;
  private readonly autoApproveBelow: PermissionLevel;
  private readonly approvalTimeoutMs: number;
  private readonly logger?: Logger;
  private readonly eventBus?: EventBus;
  /** Session-scoped remembered approvals keyed by tool name. */
  private readonly remembered = new Map<string, boolean>();

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

    // 1) Ceiling check.
    if (permissionRank(level) > permissionRank(this.ceiling)) {
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
      this.eventBus?.emitSync(
        makeEvent(this.sessionId, "permission.granted", { toolName: tool.name, level }, options.runId),
      );
      return true;
    }

    // 3) Remembered session decisions.
    const memo = this.remembered.get(tool.name);
    if (memo !== undefined) {
      this.eventBus?.emitSync(
        makeEvent(this.sessionId, "permission.granted", { toolName: tool.name, level }, options.runId),
      );
      return memo;
    }

    // 4) Interactive approval.
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

  /** Elevate the session ceiling (e.g. user grants more trust mid-session). */
  elevate(to: PermissionLevel): void {
    if (permissionRank(to) > permissionRank(this.ceiling)) {
      this.ceiling = to;
    }
  }

  private describe(tool: ToolInfo, args: Readonly<Record<string, unknown>>): string {
    return `Run ${tool.name} with ${JSON.stringify(args)}`;
  }
}
