/**
 * FluxAgent — typed event bus.
 *
 * Publish/subscribe over the `AgentEvent` union with:
 *  - `on(type, handler)` typed subscription
 *  - `any(handler)` subscription to all events
 *  - wildcard support ("tool.*")
 *  - request to stop propagation via handler return value
 *  - detached, non-throwing handler invocation
 *
 * No global state: construct per-runtime and inject.
 */

import { Logger } from "../utils/logger.ts";
import type { AgentEvent, AgentEventType } from "./events.ts";

export type EventPattern = AgentEventType | `${string}*` | "*";

export type AgentEventHandler<T extends AgentEvent = AgentEvent> = (
  event: T,
) => void | boolean | Promise<void | boolean>;

export interface EventBusOptions {
  readonly logger?: Logger;
  /** Stop iterating handlers after the first `true` return. */
  readonly stopOnTrue?: boolean;
}

interface Subscription {
  readonly pattern: EventPattern;
  readonly handler: AgentEventHandler;
}

export class EventBus {
  private readonly subs = new Set<Subscription>();
  private readonly logger?: Logger;
  private readonly stopOnTrue: boolean;

  constructor(options: EventBusOptions = {}) {
    this.logger = options.logger;
    this.stopOnTrue = options.stopOnTrue ?? false;
  }

  on<T extends AgentEvent>(type: T["type"], handler: AgentEventHandler<T>): () => void {
    return this.add(type as EventPattern, handler as AgentEventHandler);
  }

  /** Subscribe to all events. */
  any(handler: AgentEventHandler): () => void {
    return this.add("*", handler);
  }

  /** Subscribe by prefix wildcard, e.g. "tool.*". */
  pattern(pattern: `${string}*`, handler: AgentEventHandler): () => void {
    return this.add(pattern, handler);
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const sub of [...this.subs]) {
      if (!matches(sub.pattern, event.type)) continue;
      try {
        const result = await sub.handler(event);
        if (this.stopOnTrue && result === true) break;
      } catch (err) {
        this.logger?.warn("event handler failed", {
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Fire-and-forget emit; errors are logged, never thrown to the emitter. */
  emitSync(event: AgentEvent): void {
    void this.emit(event);
  }

  unsubscribeAll(): void {
    this.subs.clear();
  }

  get subscriberCount(): number {
    return this.subs.size;
  }

  private add(pattern: EventPattern, handler: AgentEventHandler): () => void {
    const sub: Subscription = { pattern, handler };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }
}

function matches(pattern: EventPattern, type: AgentEventType): boolean {
  if (pattern === "*" || pattern === type) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return type.startsWith(prefix);
  }
  return false;
}

/** Recording subscriber useful for tests and the future desktop UI. */
export class EventRecorder {
  readonly events: AgentEvent[] = [];

  attach(bus: EventBus): () => void {
    return bus.any((e) => {
      this.events.push(e);
    });
  }

  ofType<T extends AgentEvent>(type: T["type"]): Extract<AgentEvent, { type: T["type"] }>[] {
    return this.events.filter((e): e is Extract<AgentEvent, { type: T["type"] }> => e.type === type);
  }
}
