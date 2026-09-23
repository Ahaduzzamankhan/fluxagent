/**
 * Phase 4 — persistent semantic memory tests.
 * Deterministic: temp directories only, no network, no models.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  SemanticMemoryService,
  JsonFileSemanticStore,
  InMemorySemanticStore,
  tokenOverlap,
} from "../../src/memory/semantic.ts";
import { provenance } from "../../src/memory/layers.ts";

describe("tokenOverlap", () => {
  test("identical text → 1, disjoint → 0", () => {
    assert.equal(tokenOverlap("FluxAgent requires Node 22+", "FluxAgent requires Node 22+"), 1);
    assert.equal(tokenOverlap("cats like milk", "quantum flux capacitors"), 0);
  });

  test("near-duplicate scores high", () => {
    const a = "The user prefers TypeScript for new code";
    const b = "The user prefers TypeScript for new code!";
    assert.ok(tokenOverlap(a, b) > 0.9);
  });
});

describe("SemanticMemoryService", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "flux-semantic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("stores a fact with provenance and retrieves it", async () => {
    const svc = new SemanticMemoryService({ store: new InMemorySemanticStore() });
    await svc.remember({
      kind: "fact",
      content: "FluxAgent requires Node 22.6 or newer for type stripping",
      provenance: provenance("system", "fact", "docs"),
      tags: ["runtime"],
    });
    const hits = await svc.retrieve({ query: "which Node version does FluxAgent need?" });
    assert.ok(hits.length >= 1);
    assert.ok(hits[0]!.content.includes("Node 22.6"));
    assert.equal(hits[0]!.provenance.type, "fact");
  });

  test("dedup: near-identical content updates instead of duplicating", async () => {
    const svc = new SemanticMemoryService({ store: new InMemorySemanticStore(), dedupThreshold: 0.7 });
    await svc.remember({ kind: "preference", content: "The user prefers TypeScript for new projects", provenance: provenance("user", "user-provided") });
    const out = await svc.remember({ kind: "preference", content: "The user prefers TypeScript for new projects!", provenance: provenance("user", "user-provided") });
    assert.equal(out.deduplicated, true, "second write must dedup into the first");
    const all = await svc.stats();
    assert.equal(all.total, 1, `expected 1 record, got ${all.total}`);
  });

  test("distinct content is NOT deduplicated", async () => {
    const svc = new SemanticMemoryService({ store: new InMemorySemanticStore() });
    await svc.remember({ kind: "fact", content: "Project uses NodeNext module resolution", provenance: provenance("tool", "fact", "tsconfig") });
    const out = await svc.remember({ kind: "fact", content: "Deploy pipeline runs on GitHub Actions", provenance: provenance("tool", "fact", "ci") });
    assert.equal(out.deduplicated, false);
    const all = await svc.stats();
    assert.equal(all.total, 2);
  });

  test("model-generated 'fact' claims are downgraded, never stored as fact", async () => {
    const svc = new SemanticMemoryService({ store: new InMemorySemanticStore() });
    const out = await svc.remember({
      kind: "fact",
      content: "The API rate limit is definitely 10000/min",
      provenance: provenance("model", "fact", "gpt-x"), // model claiming fact
    });
    assert.equal(out.record.provenance.type, "model-generated", "model claims must be downgraded");
    assert.ok(out.record.provenance.confidence <= 0.5);
  });

  test("expired records are excluded from retrieval", async () => {
    const svc = new SemanticMemoryService({ store: new InMemorySemanticStore() });
    const past = new Date(Date.now() - 1000).toISOString();
    await svc.remember({
      kind: "experience",
      content: "Deploy window is open right now",
      provenance: provenance("system", "observation"),
      expiresAt: past,
    });
    const hits = await svc.retrieve({ query: "deploy window" });
    assert.equal(hits.length, 0, "expired record must not surface");
  });

  test("kind filter narrows retrieval", async () => {
    const svc = new SemanticMemoryService({ store: new InMemorySemanticStore() });
    await svc.remember({ kind: "preference", content: "User prefers tabs over spaces", provenance: provenance("user", "user-provided") });
    await svc.remember({ kind: "project", content: "User prefers tabs over spaces in this repo", provenance: provenance("file", "observation", "editorconfig") });
    const onlyPrefs = await svc.retrieve({ query: "tabs or spaces", kinds: ["preference"] });
    assert.ok(onlyPrefs.every((r) => r.kind === "preference"));
  });

  test("JsonFileSemanticStore persists across service instances", async () => {
    const store = new JsonFileSemanticStore({ directory: dir });
    const svc1 = new SemanticMemoryService({ store });
    await svc1.remember({
      kind: "procedure",
      content: "Run typecheck before tests in this repository",
      provenance: provenance("previous-task", "fact", "execution-history"),
    });
    await store.flush();

    // New instance over the same directory sees the record.
    const svc2 = new SemanticMemoryService({ store: new JsonFileSemanticStore({ directory: dir }) });
    const hits = await svc2.retrieve({ query: "what to run before tests?" });
    assert.ok(hits.length >= 1, "record must survive restart");
    assert.ok(hits[0]!.content.includes("typecheck"));

    const rawFile = path.join(dir, "semantic.json");
    assert.ok(existsSync(rawFile));
    const parsed: unknown = JSON.parse(readFileSync(rawFile, "utf8"));
    assert.ok(Array.isArray(parsed) && parsed.length === 1);
  });

  test("contextFeed excludes low-importance model-generated content", async () => {
    const svc = new SemanticMemoryService({ store: new InMemorySemanticStore() });
    await svc.remember({ kind: "fact", content: "FluxAgent gateway listens on port 7333 by default", provenance: provenance("tool", "fact", "config") });
    await svc.remember({ kind: "fact", content: "Gateway port is 7333 probably", provenance: provenance("model", "model-generated", "guess"), importance: 0.2 });
    const feed = await svc.contextFeed("what port does the gateway use?");
    assert.ok(feed.length >= 1);
    assert.ok(feed.every((c) => !c.includes("probably")), "low-confidence model guesses must not feed context");
  });

  test("forget() removes a record from retrieval", async () => {
    const svc = new SemanticMemoryService({ store: new InMemorySemanticStore() });
    const out = await svc.remember({ kind: "fact", content: "Temporary staging URL is staging.example.test", provenance: provenance("system", "observation") });
    await svc.forget(out.record.id);
    const hits = await svc.retrieve({ query: "staging URL" });
    assert.equal(hits.length, 0);
  });

  test("stats reports totals by kind", async () => {
    const svc = new SemanticMemoryService({ store: new InMemorySemanticStore() });
    await svc.remember({ kind: "fact", content: "Fact one about the runtime", provenance: provenance("system", "fact") });
    await svc.remember({ kind: "preference", content: "Prefers concise answers", provenance: provenance("user", "user-provided") });
    const s = await svc.stats();
    assert.equal(s.total, 2);
    assert.equal(s.byKind["fact"], 1);
    assert.equal(s.byKind["preference"], 1);
  });
});
