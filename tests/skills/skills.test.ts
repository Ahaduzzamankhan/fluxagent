/**
 * Phase 6 — skills system tests.
 * Validation, registry selection, JSON loading, built-ins, readiness.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  validateSkill,
  SkillRegistry,
  loadSkillsFromDir,
  builtinSkills,
  type Skill,
} from "../../src/skills/skill.ts";

const goodSkill: Skill = {
  name: "test-skill",
  description: "A test skill",
  version: "1.0.0",
  requiredTools: ["file.read"],
  instructions: "Do the thing carefully and verify.",
  tags: ["test"],
};

describe("validateSkill", () => {
  test("accepts a valid skill", () => {
    const res = validateSkill(goodSkill);
    assert.equal(res.valid, true);
  });

  test("rejects missing name / bad version / empty requiredTools", () => {
    const res = validateSkill({ description: "x", version: "not-semver", requiredTools: [], instructions: "long enough instructions" });
    assert.equal(res.valid, false);
    if (!res.valid) {
      const fields = res.issues.map((i) => i.field);
      assert.ok(fields.includes("name"));
      assert.ok(fields.includes("version"));
      assert.ok(fields.includes("requiredTools"));
    }
  });

  test("rejects non-object input without throwing", () => {
    assert.equal(validateSkill("nope").valid, false);
    assert.equal(validateSkill(null).valid, false);
    assert.equal(validateSkill(42).valid, false);
  });

  test("verification requires tool and args", () => {
    const res = validateSkill({ ...goodSkill, verification: { tool: "" } });
    assert.equal(res.valid, false);
  });
});

describe("SkillRegistry", () => {
  test("register / get / list / size", () => {
    const reg = new SkillRegistry();
    reg.register(goodSkill);
    reg.registerAll(builtinSkills());
    assert.equal(reg.get("test-skill")?.name, "test-skill");
    assert.equal(reg.get("coding")?.name, "coding");
    assert.ok(reg.size() >= 5);
    assert.ok(reg.list().every((s) => typeof s.name === "string"));
  });

  test("selectForGoal matches on description/tags keywords", () => {
    const reg = new SkillRegistry();
    reg.registerAll(builtinSkills());
    reg.setAvailableTools(["file.read", "file.write", "command.execute", "file.list"]);
    const picked = reg.selectForGoal("fix the failing typescript tests in my project");
    assert.ok(picked, "should pick a skill");
    assert.equal(picked!.skill.name, "coding");
    assert.deepEqual(picked!.missingTools, []);
  });

  test("selectForGoal reports missing tools instead of selecting an unready skill path", () => {
    const reg = new SkillRegistry();
    reg.registerAll(builtinSkills());
    reg.setAvailableTools(["file.read"]); // coding needs file.write + command.execute too
    const picked = reg.selectForGoal("refactor the code and run the test suite");
    assert.ok(picked);
    assert.ok(picked!.missingTools.length > 0, "must report which tools are missing");
  });

  test("selectForGoal returns undefined when nothing matches", () => {
    const reg = new SkillRegistry();
    reg.register(goodSkill);
    reg.setAvailableTools(["file.read"]);
    assert.equal(reg.selectForGoal("cook pasta carbonara"), undefined);
  });

  test("isReady / missingTools reflect the available tool set", () => {
    const reg = new SkillRegistry();
    const s: Skill = { ...goodSkill, requiredTools: ["a", "b"] };
    reg.register(s);
    reg.setAvailableTools(["a"]);
    assert.equal(reg.isReady(s), false);
    assert.deepEqual(reg.missingTools(s), ["b"]);
    reg.setAvailableTools(["a", "b"]);
    assert.equal(reg.isReady(s), true);
  });
});

describe("loadSkillsFromDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "flux-skills-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loads valid .skill.json files, reports invalid ones without throwing", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "good.skill.json"),
      JSON.stringify(goodSkill, null, 2),
    );
    writeFileSync(
      path.join(dir, "bad.skill.json"),
      JSON.stringify({ name: "Bad Name!", description: "", version: "1.0", requiredTools: "nope", instructions: "short" }),
    );
    writeFileSync(path.join(dir, "broken.skill.json"), "{ not json");

    const res = await loadSkillsFromDir(dir);
    assert.equal(res.loaded.length, 1);
    assert.equal(res.loaded[0]!.name, "test-skill");
    assert.equal(res.failed.length, 2, "invalid + broken must be reported");
    assert.ok(res.failed.every((f) => f.issues.length > 0));
  });

  test("missing directory yields empty result, not a throw", async () => {
    const res = await loadSkillsFromDir(path.join(dir, "does-not-exist"));
    assert.deepEqual(res.loaded, []);
    assert.deepEqual(res.failed, []);
  });
});

describe("builtinSkills", () => {
  test("all built-ins validate and have unique names", () => {
    const skills = builtinSkills();
    assert.ok(skills.length >= 4);
    const names = new Set(skills.map((s) => s.name));
    assert.equal(names.size, skills.length, "names must be unique");
    for (const s of skills) {
      const res = validateSkill(s);
      assert.equal(res.valid, true, `builtin ${s.name} must validate: ${JSON.stringify(res.valid ? "" : res.issues)}`);
    }
  });

  test("coding skill requires the core coding tools", () => {
    const coding = builtinSkills().find((s) => s.name === "coding")!;
    assert.ok(coding.requiredTools.includes("file.read"));
    assert.ok(coding.requiredTools.includes("file.write"));
    assert.ok(coding.requiredTools.includes("command.execute"));
  });
});
