/**
 * FluxAgent — identifier generation and time helpers.
 *
 * Uses crypto.randomUUID (Node 19+). No dependencies.
 */

import { randomUUID } from "node:crypto";

/** Prefixed short ids, e.g. `step_9f1c2ab3c4d5e6f70811`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export const ids = {
  session: (): string => newId("sess"),
  run: (): string => newId("run"),
  plan: (): string => newId("plan"),
  step: (): string => newId("step"),
  observation: (): string => newId("obs"),
  toolCall: (): string => newId("call"),
  approval: (): string => newId("appr"),
  event: (): string => newId("evt"),
  error: (): string => newId("err"),
} as const;
