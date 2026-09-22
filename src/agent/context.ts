/**
 * FluxAgent — run context.
 *
 * Assembles the provider-neutral context (messages, plan summary, recent
 * observations, tool descriptors) the brain sends to the LLM. Pure assembly:
 * no I/O, fully injectable.
 */

import type { StateManager } from "./state.ts";
import type { ConversationMemory } from "../memory/conversation.ts";
import type { ToolInfo } from "../tools/tool.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { buildPlanMessages, buildDecideMessages } from "../llm/provider.ts";
import type { LlmMessage } from "../llm/message.ts";

export interface RunContextOptions {
  readonly state: StateManager;
  readonly conversation: ConversationMemory;
  readonly registry: ToolRegistry;
  readonly maxObservationsInContext?: number;
  readonly systemPrompt?: string;
}

export interface PlanSummary {
  readonly planId: string | null;
  readonly revision: number;
  readonly summary: string;
  readonly steps: readonly {
    id: string;
    title: string;
    status: string;
    tool: string | null;
    retryCount: number;
  }[];
}

export class RunContext {
  private readonly state: StateManager;
  private readonly conversation: ConversationMemory;
  private readonly registry: ToolRegistry;
  private readonly maxObservations: number;
  private readonly systemPrompt: string;

  constructor(options: RunContextOptions) {
    this.state = options.state;
    this.conversation = options.conversation;
    this.registry = options.registry;
    this.maxObservations = options.maxObservationsInContext ?? 6;
    this.systemPrompt =
      options.systemPrompt ??
      "You are FluxAgent, a careful Windows automation agent. Decide actions through registered tools only. Prefer verification and safe recovery over blind retries.";
  }

  toolInfos(): ToolInfo[] {
    return this.registry.list();
  }

  planSummary(): PlanSummary {
    const s = this.state.get();
    if (!s.plan) {
      return { planId: null, revision: 0, summary: "", steps: [] };
    }
    return {
      planId: s.plan.id,
      revision: s.plan.revision,
      summary: s.plan.summary,
      steps: s.plan.steps.map((st) => ({
        id: st.id,
        title: st.title,
        status: st.status,
        tool: st.tool,
        retryCount: st.retryCount,
      })),
    };
  }

  recentObservationLines(): string[] {
    const s = this.state.get();
    return s.observations.slice(-this.maxObservations).map((o) => {
      const body = o.ok
        ? JSON.stringify(o.output)?.slice(0, 300) ?? "(no output)"
        : `ERROR ${o.error?.code}: ${o.error?.message}`;
      return `[${o.toolName}] ${o.ok ? "ok" : "fail"} → ${body}`;
    });
  }

  /** Messages for planning calls. */
  planMessages(goal: string): LlmMessage[] {
    return buildPlanMessages(goal, this.toolInfos());
  }

  /** Messages for decide calls (system prompt + transcript). */
  decideMessages(goal: string): LlmMessage[] {
    const summary = this.planSummary();
    const summaryText = summary.planId
      ? `plan ${summary.planId} rev${summary.revision}: ${summary.summary}\n` +
        summary.steps.map((st) => `- [${st.status}] ${st.title} (tool: ${st.tool ?? "none"})`).join("\n")
      : "no plan yet";
    return buildDecideMessages(goal, summaryText, this.recentObservationLines(), this.toolInfos());
  }

  /** Full conversation rendering (used by generate() calls). */
  conversationMessages(): LlmMessage[] {
    return this.conversation.toLlmMessages(this.systemPrompt);
  }
}
