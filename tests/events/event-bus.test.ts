/**
 * Event bus tests: typed emit/on, wildcard patterns, recorder, error
 * isolation between handlers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { EventBus, EventRecorder } from "../../src/events/event-bus.ts";
import { makeEvent } from "../../src/events/events.ts";

test("typed on/emit delivers matching events", async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.on("agent.started", (e) => {
    seen.push(e.goal);
  });
  await bus.emit(makeEvent("s1", "agent.started", { goal: "write file" }));
  assert.deepEqual(seen, ["write file"]);
});

test("wildcard pattern matches prefixes", async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.pattern("tool.*", (e) => {
    seen.push(e.type);
  });
  await bus.emit(makeEvent("s1", "tool.called", { toolName: "file.read", callId: "c1", args: {} }));
  await bus.emit(makeEvent("s1", "agent.started", { goal: "g" }));
  assert.deepEqual(seen, ["tool.called"]);
});

test("handler errors do not break other handlers", async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.on("plan.created", () => {
    throw new Error("boom");
  });
  bus.on("plan.created", (e) => {
    seen.push(e.planId);
  });
  await bus.emit(makeEvent("s1", "plan.created", { planId: "p1", stepCount: 3 }));
  assert.deepEqual(seen, ["p1"]);
});

test("recorder captures all events", async () => {
  const bus = new EventBus();
  const rec = new EventRecorder();
  rec.attach(bus);
  await bus.emit(makeEvent("s1", "session.started", {}));
  await bus.emit(makeEvent("s1", "agent.completed", { summary: "done" }));
  assert.equal(rec.events.length, 2);
  assert.equal(rec.ofType("agent.completed").length, 1);
});
