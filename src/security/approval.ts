/**
 * FluxAgent — approval interfaces.
 *
 * The desktop UI does not exist yet; `ApprovalRequester` is the seam it will
 * implement. `ConsoleApprovalRequester` is a working default for CLI usage,
 * and `AutoDenyApprovalRequester` keeps headless runs safe.
 */

import type { PermissionLevel } from "../tools/permissions.ts";
import { ApprovalRejectedError, ApprovalTimeoutError } from "../utils/errors.ts";
import { sleep } from "../utils/validation.ts";

export interface ApprovalRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly level: PermissionLevel;
  /** Human-readable description of exactly what will happen. */
  readonly action: string;
  readonly argsPreview: Readonly<Record<string, unknown>>;
}

export interface ApprovalDecision {
  readonly requestId: string;
  readonly approved: boolean;
  readonly reason?: string;
  /** Remember this decision for the rest of the session. */
  readonly remember?: boolean;
}

export interface ApprovalRequester {
  request(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export class AutoApproveRequester implements ApprovalRequester {
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    return { requestId: request.requestId, approved: true };
  }
}

export class AutoDenyApprovalRequester implements ApprovalRequester {
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    return { requestId: request.requestId, approved: false, reason: "headless mode auto-deny" };
  }
}

export class ConsoleApprovalRequester implements ApprovalRequester {
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const line = "─".repeat(60);
    console.log(`\n${line}`);
    console.log(`APPROVAL REQUIRED [${request.level}] ${request.toolName}`);
    console.log(request.action);
    console.log(JSON.stringify(request.argsPreview, null, 2));
    console.log(`${line}`);
    process.stdout.write("Approve? [y/N/a(ways)] ");

    const answer = await readLine();
    const normalized = answer.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") return { requestId: request.requestId, approved: true };
    if (normalized === "a") return { requestId: request.requestId, approved: true, remember: true };
    return { requestId: request.requestId, approved: false, reason: "user denied in console" };
  }
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.removeListener("data", onData);
      resolve(chunk.toString().trim());
    };
    process.stdin.once("data", onData);
  });
}

/** Timeout wrapper: converts a hanging requester into an ApprovalTimeoutError. */
export async function requestWithTimeout(
  requester: ApprovalRequester,
  request: ApprovalRequest,
  timeoutMs: number,
): Promise<ApprovalDecision> {
  if (timeoutMs <= 0) return requester.request(request);
  const result = await Promise.race([
    requester.request(request).then(
      (d) => d,
      (e) => { throw e; },
    ),
    sleep(timeoutMs).then(() => null),
  ]);
  if (result === null) throw new ApprovalTimeoutError(request.action, timeoutMs);
  return result;
}
