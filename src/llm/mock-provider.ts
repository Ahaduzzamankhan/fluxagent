/**
 * FluxAgent — mock LLM provider.
 *
 * Deterministic, script-driven provider for tests and offline development.
 * It is NOT a fake AI: it implements the same LlmProvider interface so the
 * whole agent loop runs without any API keys or network access.
 */

import type {
  LlmProvider,
  LlmGenerateOptions,
  PlannedPlan,
  AgentDecision,
} from "./provider.ts";
import type { LlmResponse, StreamChunk } from "./response.ts";
import type { ToolInfo } from "../tools/tool.ts";

export interface MockDecision {
  readonly thought: string;
  readonly kind: "do" | "finish";
  readonly tool?: string;
  readonly args?: Record<string, unknown>;
  readonly answer?: string;
}

export interface MockLlmProviderOptions {
  /** Plan returned by plan() — supply a deterministic script. */
  readonly plan?: PlannedPlan;
  /** Decisions consumed in order by decideTool(). */
  readonly decisions?: readonly MockDecision[];
  /** Text returned by generate(). */
  readonly generateText?: string;
  readonly defaultModel?: string;
  readonly name?: string;
}

export class MockLlmProvider implements LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  private readonly scriptedPlan?: PlannedPlan;
  private readonly decisions: MockDecision[];
  private decisionIndex = 0;
  private readonly generateText: string;

  constructor(options: MockLlmProviderOptions = {}) {
    this.name = options.name ?? "mock";
    this.defaultModel = options.defaultModel ?? "mock:deterministic";
    this.scriptedPlan = options.plan;
    this.decisions = [...(options.decisions ?? [])];
    this.generateText = options.generateText ?? "(mock response)";
  }

  async generate(options: LlmGenerateOptions): Promise<LlmResponse> {
    void options;
    return { text: this.generateText, toolCalls: [], stopReason: "stop", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }

  async *stream(options: LlmGenerateOptions): AsyncGenerator<StreamChunk> {
    const res = await this.generate(options);
    yield { type: "text", value: res.text };
    yield { type: "done", finishReason: "stop" };
  }

  async plan(options: { goal: string; availableTools: readonly ToolInfo[]; signal?: AbortSignal }): Promise<PlannedPlan> {
    if (this.scriptedPlan) return this.scriptedPlan;
    // Sensible deterministic default: one reasoning step, then finish.
    return {
      summary: `deterministic plan for: ${options.goal}`,
      steps: [{ id: "s1", title: "acknowledge goal", tool: null }],
    };
  }

  async decideTool(options: {
    goal: string;
    planSummary: string;
    recentObservations: readonly string[];
    availableTools: readonly ToolInfo[];
    signal?: AbortSignal;
  }): Promise<AgentDecision> {
    void options;
    const next = this.decisions[this.decisionIndex];
    this.decisionIndex += 1;
    if (!next) {
      return { kind: "finish", thought: "mock: no decisions left", answer: "done" };
    }
    return {
      kind: next.kind,
      ...(next.tool ? { tool: next.tool } : {}),
      ...(next.args ? { args: next.args } : {}),
      thought: next.thought,
      ...(next.answer ? { answer: next.answer } : {}),
    };
  }

  get decisionsConsumed(): number {
    return this.decisionIndex;
  }
}
