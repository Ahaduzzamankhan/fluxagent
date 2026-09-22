/**
 * FluxAgent — conversation memory helpers.
 *
 * Bridges short-term memory ↔ LLM messages and keeps the transcript bounded
 * for provider context windows.
 */

import type { ConversationTurn, ShortTermMemory } from "./memory.ts";
import type { LlmMessage } from "../llm/message.ts";
import { userMessage, systemMessage, assistantMessage } from "../llm/message.ts";

export interface ConversationMemoryOptions {
  /** Max turns sent to the provider in one request. */
  readonly maxContextTurns?: number;
}

export class ConversationMemory {
  private readonly shortTerm: ShortTermMemory;
  private readonly maxContextTurns: number;

  constructor(shortTerm: ShortTermMemory, options: ConversationMemoryOptions = {}) {
    this.shortTerm = shortTerm;
    this.maxContextTurns = options.maxContextTurns ?? 40;
  }

  recordUser(text: string, meta?: Record<string, unknown>): void {
    this.shortTerm.pushMessage({ role: "user", content: text, at: new Date().toISOString(), ...(meta ? { meta } : {}) });
  }

  recordAgent(text: string, meta?: Record<string, unknown>): void {
    this.shortTerm.pushMessage({ role: "agent", content: text, at: new Date().toISOString(), ...(meta ? { meta } : {}) });
  }

  recordSystem(text: string): void {
    this.shortTerm.pushMessage({ role: "system", content: text, at: new Date().toISOString() });
  }

  /** Render the bounded transcript as provider-neutral LLM messages. */
  toLlmMessages(systemPrompt?: string): LlmMessage[] {
    const turns = this.shortTerm.getMessages(this.maxContextTurns);
    const out: LlmMessage[] = [];
    if (systemPrompt) out.push(systemMessage(systemPrompt));
    for (const t of turns) {
      if (t.role === "user") out.push(userMessage(t.content));
      else if (t.role === "agent") out.push(assistantMessage(t.content));
      else out.push(systemMessage(t.content));
    }
    return out;
  }

  transcript(): readonly ConversationTurn[] {
    return this.shortTerm.getMessages();
  }
}
