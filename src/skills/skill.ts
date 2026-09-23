/**
 * FluxAgent — skills system (Phase 6).
 *
 * A skill is a reusable, high-level capability definition: required tools,
 * instruction text for the model, constraints, and an optional verification
 * spec. Skills do NOT bypass the tool registry or permission system — they
 * are injected into the model context as guidance, and their required tools
 * must exist in the registry before a skill can be selected.
 *
 * This module exports:
 *   - Skill shape + validateSkill (schema-ish validation with structured errors)
 *   - SkillRegistry (register / get / list / select-by-goal)
 *   - loadSkillsFromDir (JSON skill files; zero dependencies)
 *   - builtinSkills (coding, debugging, file-management, research)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

// ─── Skill shape ──────────────────────────────────────────────────────────────

export interface SkillVerification {
  /** Tool name to run as the verification step (e.g. command.execute). */
  readonly tool: string;
  /** Args template; `${result.<tool>.<field>}` references are substituted. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Substring or regex source expected in the verification output. */
  readonly expectContains?: string;
}

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** Tools that MUST be present in the registry for the skill to be usable. */
  readonly requiredTools: readonly string[];
  /** Injected into the model context when the skill is selected. */
  readonly instructions: string;
  /** Hard constraints the planner must respect (advisory but validated). */
  readonly constraints?: readonly string[];
  /** Optional verification spec checked after execution. */
  readonly verification?: SkillVerification;
  readonly tags?: readonly string[];
}

export interface SkillValidationIssue {
  readonly field: string;
  readonly message: string;
}

/** Structured validation — never throws for user-authored skills. */
export function validateSkill(raw: unknown): { valid: true; skill: Skill } | { valid: false; issues: SkillValidationIssue[] } {
  const issues: SkillValidationIssue[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { valid: false, issues: [{ field: "$", message: "skill must be an object" }] };
  }
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string";

  if (!str(r.name) || r.name.trim().length === 0) issues.push({ field: "name", message: "required non-empty string" });
  else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(r.name)) issues.push({ field: "name", message: "letters, digits, dot, dash, underscore only" });

  if (!str(r.description) || r.description.trim().length === 0) issues.push({ field: "description", message: "required non-empty string" });

  if (!str(r.version) || !/^\d+\.\d+\.\d+$/.test(r.version)) issues.push({ field: "version", message: "must be semver MAJOR.MINOR.PATCH" });

  if (!Array.isArray(r.requiredTools) || r.requiredTools.length === 0 || !r.requiredTools.every(str)) {
    issues.push({ field: "requiredTools", message: "required non-empty array of tool names" });
  }

  if (!str(r.instructions) || r.instructions.trim().length < 10) {
    issues.push({ field: "instructions", message: "required, at least 10 chars of guidance for the model" });
  }

  if (r.constraints !== undefined) {
    if (!Array.isArray(r.constraints) || !r.constraints.every(str)) {
      issues.push({ field: "constraints", message: "optional array of strings" });
    }
  }

  if (r.verification !== undefined) {
    const v = r.verification as Record<string, unknown>;
    if (typeof v !== "object" || v === null || !str(v.tool)) {
      issues.push({ field: "verification.tool", message: "required when verification is present" });
    }
    if (typeof v !== "object" || v === null || typeof v.args !== "object" || v.args === null) {
      issues.push({ field: "verification.args", message: "required object when verification is present" });
    }
  }

  if (issues.length > 0) return { valid: false, issues };
  return {
    valid: true,
    skill: {
      name: r.name as string,
      description: r.description as string,
      version: r.version as string,
      requiredTools: r.requiredTools as readonly string[],
      instructions: r.instructions as string,
      ...(Array.isArray(r.constraints) ? { constraints: r.constraints as readonly string[] } : {}),
      ...(r.verification !== undefined ? { verification: r.verification as SkillVerification } : {}),
      ...(Array.isArray(r.tags) ? { tags: r.tags as readonly string[] } : {}),
    },
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  /** Tools currently available (set by the runtime for selection checks). */
  private availableTools = new Set<string>();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  registerAll(skills: readonly Skill[]): void {
    for (const s of skills) this.register(s);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): readonly Skill[] {
    return [...this.skills.values()];
  }

  size(): number {
    return this.skills.size;
  }

  /** Runtime informs which tools exist; unready skills are not selectable. */
  setAvailableTools(names: readonly string[]): void {
    this.availableTools = new Set(names);
  }

  /** A skill is usable when every requiredTool exists. */
  isReady(skill: Skill): boolean {
    return skill.requiredTools.every((t) => this.availableTools.has(t));
  }

  missingTools(skill: Skill): readonly string[] {
    return skill.requiredTools.filter((t) => !this.availableTools.has(t));
  }

  /**
   * Select the best skill for a goal by keyword overlap on name/description/
   * tags/instructions. Deterministic; ties broken by name. Returns undefined
   * when nothing matches or the best match is not ready.
   */
  selectForGoal(goal: string): { skill: Skill; missingTools: readonly string[] } | undefined {
    const goalTokens = new Set(
      goal.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2),
    );
    let best: { skill: Skill; score: number } | undefined;
    for (const s of this.skills.values()) {
      const haystack = `${s.name} ${s.description} ${(s.tags ?? []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const t of goalTokens) if (haystack.includes(t)) score++;
      if (score > 0 && (!best || score > best.score)) best = { skill: s, score };
    }
    if (!best) return undefined;
    return { skill: best.skill, missingTools: this.missingTools(best.skill) };
  }
}

// ─── Loader (JSON skill files) ────────────────────────────────────────────────

export interface SkillLoadResult {
  readonly loaded: Skill[];
  readonly failed: { file: string; issues: readonly SkillValidationIssue[] }[];
}

/** Load every *.skill.json in a directory; invalid files are reported, not fatal. */
export async function loadSkillsFromDir(dir: string): Promise<SkillLoadResult> {
  const loaded: Skill[] = [];
  const failed: SkillLoadResult["failed"] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { loaded, failed };
  }
  for (const name of entries.filter((f) => f.endsWith(".skill.json"))) {
    const file = path.join(dir, name);
    try {
      const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      const res = validateSkill(raw);
      if (res.valid) loaded.push(res.skill);
      else failed.push({ file, issues: res.issues });
    } catch (err) {
      failed.push({ file, issues: [{ field: "$", message: `unreadable: ${(err as Error).message}` }] });
    }
  }
  return { loaded, failed };
}

// ─── Built-in skills ──────────────────────────────────────────────────────────

/** Built-in skills shipped with the runtime. */
export function builtinSkills(): Skill[] {
  return [
    {
      name: "coding",
      description: "Modify a codebase safely: inspect, edit minimally, typecheck, test",
      version: "1.0.0",
      requiredTools: ["file.read", "file.write", "command.execute"],
      instructions: [
        "1. Read the relevant files before changing anything.",
        "2. Make the smallest change that solves the task.",
        "3. Run the project's typecheck, then its tests.",
        "4. Verify the actual output — never assume success from exit codes alone.",
        "5. Report exactly what changed and why.",
      ].join("\n"),
      constraints: [
        "No unrelated reformatting or refactors",
        "Never delete tests to make them pass",
      ],
      verification: {
        tool: "command.execute",
        args: { command: "npm", args: ["run", "test"] },
        expectContains: "pass",
      },
      tags: ["code", "typescript", "tests", "refactor", "fix"],
    },
    {
      name: "debugging",
      description: "Diagnose a failure: reproduce, read errors, narrow down, propose fix",
      version: "1.0.0",
      requiredTools: ["file.read", "command.execute"],
      instructions: [
        "1. Reproduce the failure with the exact command.",
        "2. Read the full error output before theorizing.",
        "3. Form one hypothesis at a time and test it.",
        "4. Distinguish observation from inference in the report.",
      ].join("\n"),
      constraints: ["Do not apply fixes before the cause is understood"],
      tags: ["debug", "error", "failure", "diagnose", "bug"],
    },
    {
      name: "file-management",
      description: "Organize, move, rename, and clean up files inside the sandbox",
      version: "1.0.0",
      requiredTools: ["file.list", "file.write"],
      instructions: [
        "1. List the target directory first; show the user what you found.",
        "2. Prefer moves over delete+recreate.",
        "3. Confirm destructive operations (deletes, overwrites) with the user.",
      ].join("\n"),
      constraints: ["Stay inside the sandbox roots"],
      tags: ["files", "organize", "rename", "move", "cleanup"],
    },
    {
      name: "research",
      description: "Read-only investigation of a codebase or data using safe tools",
      version: "1.0.0",
      requiredTools: ["file.read", "file.list"],
      instructions: [
        "1. Start broad (list), then narrow (read) based on what you find.",
        "2. Quote file paths and line numbers for every claim.",
        "3. Clearly separate verified facts from hypotheses.",
      ].join("\n"),
      tags: ["research", "explore", "understand", "read", "analyze"],
    },
  ];
}
