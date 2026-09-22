/**
 * FluxAgent — reasoning layer.
 *
 * The ONLY module that talks to the LLM for decisions. It converts
 * provider-neutral responses into typed AgentDecision / PlannedPlan objects
 * and shields the rest of the agent from provider quirks.
 */

import type { LlmProvider, PlannedPlan, AgentDecision } from "../llm/provider.ts";
import type { RunContext } from "./context.ts";
import type { Logger } from "../utils/logger.ts";
import { toFluxError } from "../utils/errors.ts";
import type { ToolInfo } from "../tools/tool.ts";

export interface ReasoningOptions {
  readonly provider: LlmProvider;
  readonly context: RunContext;
  readonly logger?: Logger;
}

export class ReasoningEngine {
  private readonly provider: LlmProvider;
  private readonly context: RunContext;
  private readonly logger?: Logger;

  constructor(options: ReasoningOptions) {
    this.provider = options.provider;
    this.context = options.context;
    this.logger = options.logger;
  }

  /** UNDERSTAND + CREATE PLAN: ask the provider for a structured plan. */
  async createPlan(goal: string, signal?: AbortSignal): Promise<PlannedPlan> {
    const tools = this.context.toolInfos();
    this.logger?.info("requesting plan from provider", { goal, toolCount: tools.length });
    return this.provider.plan({ goal, availableTools: tools, signal });
  }

  /** SELECT NEXT ACTION: ask the provider for the next decision. */
  async decide(goal: string, signal?: AbortSignal): Promise<AgentDecision> {
    return this.provider.decideTool({
      goal,
      planSummary: this.planSummaryText(),
      recentObservations: this.context.recentObservationLines(),
      availableTools: this.context.toolInfos(),
      signal,
    });
  }

  /** Free-form generation (used for summaries/answers). */
  async generateText(goal: string, instruction: string, signal?: AbortSignal): Promise<string> {
    const { systemMessage, userMessage } = await import("../llm/message.ts");
    const res = await this.provider.generate({
      messages: [systemMessage(instruction), userMessage(goal)],
      signal,
    });
    return res.text;
  }

  private planSummaryText(): string {
    const s = this.context.planSummary();
    if (!s.planId) return "no plan yet";
    return (
      `plan ${s.planId} rev${s.revision}: ${s.summary}\n` +
      s.steps.map((st) => `- [${st.status}] ${st.title} (tool: ${st.tool ?? "none"}, retries: ${st.retryCount})`).join("\n")
    );
  }
}
