/**
 * Memory tests: short-term bounds/truncation, long-term put/query/outcomes,
 * conversation rendering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryShortTermMemory } from "../../src/memory/short-term.ts";
import { InMemoryLongTermMemory } from "../../src/memory/long-term.ts";
import { ConversationMemory } from "../../src/memory/conversation.ts";
import { makeObservation } from "../../src/agent/state.ts";

test("short-term memory trims to maxMessages", () => {
  const mem = new InMemoryShortTermMemory({ maxMessages: 3 });
  for (let i = 0; i < 5; i++) {
    mem.pushMessage({ role: "user", content: `m${i}`, at: new Date().toISOString() });
  }
  const msgs = mem.getMessages();
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0]!.content, "m2");
});

test("short-term memory truncates oversized observation output", () => {
  const mem = new InMemoryShortTermMemory({ observationTruncationLength: 50 });
  const big = "x".repeat(500);
  const obs = makeObservation({
    sessionId: "s",
    toolName: "test",
    callId: "c",
    ok: true,
    output: { blob: big },
    durationMs: 1,
  });
  mem.pushObservation(obs);
  const recent = mem.recentObservations();
  assert.equal(recent.length, 1);
  assert.ok(JSON.stringify(recent[0]!.output).length < 200, "output must be truncated");
  assert.ok(recent[0]!.notes?.includes("truncated"));
});

test("in-memory long-term memory put/get/query/recordTaskOutcome", async () => {
  const lt = new InMemoryLongTermMemory();
  await lt.put({ key: "fact:1", kind: "fact", value: { text: "node runs js" } });
  await lt.put({ key: "fact:2", kind: "fact", value: { text: "python runs py" } });
  const got = await lt.get("fact:1");
  assert.ok(got);
  const queried = await lt.query({ text: "python" });
  assert.equal(queried.length, 1);
  await lt.recordTaskOutcome({ goal: "g", success: true, summary: "done", stepsTaken: 3 });
  const tasks = await lt.query({ kinds: ["task"] });
  assert.equal(tasks.length, 1);
  await lt.delete("fact:1");
  assert.equal(await lt.get("fact:1"), undefined);
});

test("conversation memory renders bounded LLM messages", () => {
  const short = new InMemoryShortTermMemory({ maxMessages: 2 });
  const conv = new ConversationMemory(short, { maxContextTurns: 2 });
  conv.recordSystem("system rules");
  conv.recordUser("first");
  conv.recordAgent("ack");
  conv.recordUser("second");
  const msgs = conv.toLlmMessages("SYS");
  // system prompt + 2 bounded turns
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0]!.role, "system");
  const roles = msgs.slice(1).map((m) => m.role);
  assert.deepEqual(roles, ["assistant", "user"], "keeps the most recent turns as provider roles");
});
