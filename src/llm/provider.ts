/**
 * FluxAgent — LLM provider abstraction.
 *
 * The agent brain depends only on `LlmProvider`; concrete adapters
 * (OpenAI, Anthropic, Azure, local models) implement this interface later.
 * Credentials come from config/env at adapter construction time — never
 * hard-coded.
 *
 * TODO(dependency): HTTP adapters will need no extra deps (use node:http/https)
 * but may adopt `openai` / `@anthropic-ai/sdk` packages later for convenience.
 */

import type { LlmMessage } from "./message.ts";
import type { LlmResponse, StreamChunk } from "./response.ts";
import type { ModelDescriptor, RoutingConstraints } from "./model.ts";
import type { ToolInfo } from "../tools/tool.ts";

export interface LlmGenerateOptions {
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly ToolInfo[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/**
 * The single brain boundary. `plan()`/`decideTool()` are convenience
 * composition methods that providers MAY implement by default via `generate()`.
 */
export interface LlmProvider {
  readonly name: string;
  readonly defaultModel: string;

  generate(options: LlmGenerateOptions): Promise<LlmResponse>;

  stream(options: LlmGenerateOptions): AsyncIterable<StreamChunk>;

  /**
   * Ask the model to produce a Plan for a goal.
   * Default implementation wraps generate() with a plan prompt; providers
   * with native structured output may override.
   */
  plan(options: {
    goal: string;
    availableTools: readonly ToolInfo[];
    context?: string;
    signal?: AbortSignal;
  }): Promise<PlannedPlan>;

  /**
   * Decide the next action given current state.
   * Default implementation wraps generate() with a decide prompt.
   */
  decideTool(options: {
    goal: string;
    planSummary: string;
    recentObservations: readonly string[];
    availableTools: readonly ToolInfo[];
    signal?: AbortSignal;
  }): Promise<AgentDecision>;
}

// ─── Planning / decision contracts ────────────────────────────────────────────

export interface PlannedStep {
  readonly id?: string;
  readonly title: string;
  readonly description?: string;
  readonly tool?: string;
  readonly args?: Record<string, unknown>;
  readonly dependsOn?: readonly string[];
}

export interface PlannedPlan {
  readonly summary: string;
  readonly steps: readonly PlannedStep[];
}

export interface AgentDecision {
  readonly kind: "do" | "finish";
  /** When kind === "do": the tool to call. */
  readonly tool?: string;
  readonly args?: Record<string, unknown>;
  readonly thought: string;
  readonly answer?: string;
}

// ─── Default prompt-driven implementations ────────────────────────────────────

export function parsePlanJson(raw: string): PlannedPlan {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`LLM returned no JSON object for plan: ${raw.slice(0, 200)}`);
  }
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("steps" in parsed) ||
    !Array.isArray((parsed as { steps: unknown }).steps)
  ) {
    throw new Error("LLM plan JSON missing steps array");
  }
  return parsed as PlannedPlan;
}

export function parseDecisionJson(raw: string): AgentDecision {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`LLM returned no JSON object for decision: ${raw.slice(0, 200)}`);
  }
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("LLM decision JSON is not an object");
  }
  return parsed as AgentDecision;
}

/** Shared planning prompt — providers may reuse or replace it. */
export function buildPlanMessages(
  goal: string,
  tools: readonly ToolInfo[],
  context?: string,
): LlmMessage[] {
  const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return [
    {
      role: "system",
      content: [
        {
          type: "text",
          text: [
            "You are FluxAgent's planner. Decompose the user's goal into concrete steps.",
            "Each step must use one of the available tools when action is required.",
            "Respond with ONLY a JSON object:",
            '{"summary": string, "steps": [{"id": string, "title": string, "description": string, "tool": string|null, "args": object|null, "dependsOn": string[]}]}',
            "Steps with tool=null are reasoning/verification steps executed by the agent itself.",
            "dependsOn lists ids of steps that must complete first.",
          ].join("\n"),
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            `GOAL: ${goal}`,
            context ? `CONTEXT: ${context}` : "",
            "AVAILABLE TOOLS:",
            toolLines,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    },
  ];
}

export function buildDecideMessages(
  goal: string,
  planSummary: string,
  recentObservations: readonly string[],
  tools: readonly ToolInfo[],
): LlmMessage[] {
  const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const obs = recentObservations.slice(-8);
  return [
    {
      role: "system",
      content: [
        {
          type: "text",
          text: [
            "You are FluxAgent's decision engine.",
            "Given the goal, current plan state, and recent observations, decide the next action.",
            'Respond with ONLY JSON: {"kind": "do"|"finish", "tool": string|null, "args": object|null, "thought": string, "answer": string|null}',
            'kind="do" executes the given tool; kind="finish" ends the run with `answer`.',
          ].join("\n"),
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            `GOAL: ${goal}`,
            `PLAN: ${planSummary}`,
            "RECENT OBSERVATIONS:",
            ...(obs.length ? obs : ["(none)"]),
            "AVAILABLE TOOLS:",
            toolLines,
          ].join("\n\n"),
        },
      ],
    },
  ];
}
