/**
 * Test helpers — mock provider scripts and a scriptable approval requester.
 * No external AI APIs are used anywhere in the test suite.
 */

import { MockLlmProvider } from "../../src/llm/mock-provider.ts";
import type { PlannedPlan } from "../../src/llm/provider.ts";
import type { ApprovalRequester, ApprovalRequest, ApprovalDecision } from "../../src/security/approval.ts";

export function scriptedProvider(opts: {
  plan: PlannedPlan;
  decisions?: Parameters<typeof MockLlmProvider.prototype.decideTool> extends never ? never : readonly {
    thought: string;
    kind: "do" | "finish";
    tool?: string;
    args?: Record<string, unknown>;
    answer?: string;
  }[];
}): MockLlmProvider {
  return new MockLlmProvider({ plan: opts.plan, decisions: opts.decisions });
}

export class ScriptedApprovals implements ApprovalRequester {
  private readonly answers = new Map<string, boolean>();
  readonly requests: ApprovalRequest[] = [];

  approve(toolName: string): this {
    this.answers.set(toolName, true);
    return this;
  }

  deny(toolName: string): this {
    this.answers.set(toolName, false);
    return this;
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    const answer = this.answers.get(request.toolName);
    return { requestId: request.requestId, approved: answer ?? false, reason: answer ? undefined : "scripted denial" };
  }
}
