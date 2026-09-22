/**
 * FluxAgent — session.
 *
 * A Session owns the per-conversation graph: state, memory, event bus,
 * permissions, and the agent. Sessions are created by the Runtime; each has a
 * unique id and is serializable for checkpoint/resume.
 */

import { ids } from "../utils/ids.ts";
import { Logger } from "../utils/logger.ts";
import { EventBus } from "../events/event-bus.ts";
import { StateManager, serializeState, deserializeState } from "../agent/state.ts";
import { InMemoryShortTermMemory } from "../memory/short-term.ts";
import type { LongTermMemory } from "../memory/memory.ts";
import { MemoryManager } from "../memory/memory.ts";
import { ConversationMemory } from "../memory/conversation.ts";
import { makeEvent } from "../events/events.ts";

export interface SessionOptions {
  readonly goal?: string;
  readonly logger?: Logger;
  readonly longTermMemory?: LongTermMemory;
}

export class Session {
  readonly id: string;
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly state: StateManager;
  readonly shortTerm: InMemoryShortTermMemory;
  readonly longTerm: LongTermMemory;
  readonly memory: MemoryManager;
  readonly conversation: ConversationMemory;

  constructor(options: SessionOptions = {}) {
    this.id = ids.session();
    this.logger = options.logger ?? new Logger({ component: "session", level: "info" });
    this.bus = new EventBus({ logger: this.logger });
    this.state = new StateManager(this.id, options.goal ?? "");
    this.shortTerm = new InMemoryShortTermMemory();
    this.longTerm = options.longTermMemory ?? (undefined as unknown as LongTermMemory);
    this.memory = new MemoryManager(this.shortTerm, this.longTerm);
    this.conversation = new ConversationMemory(this.shortTerm);

    this.bus.emitSync(makeEvent(this.id, "session.started", { ...(options.goal ? { goal: options.goal } : {}) }));
  }

  checkpoint(): string {
    return serializeState(this.state.get());
  }

  restore(json: string): void {
    this.state.replaceWith(deserializeState(json));
    this.bus.emitSync(makeEvent(this.id, "checkpoint.restored", { label: "session-state" }));
  }

  async end(reason = "finished"): Promise<void> {
    this.bus.emitSync(makeEvent(this.id, "session.ended", { reason }));
    this.bus.unsubscribeAll();
  }
}
