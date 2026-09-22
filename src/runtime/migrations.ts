/**
 * FluxAgent — configuration migrations.
 *
 * Old config files must keep loading after format changes. Migrations are
 * pure functions on the raw JSON object, applied in order from the file's
 * `configVersion` (missing = v0, the pre-release format) to CURRENT. Each
 * migration is a small, testable, documented step — see docs/MIGRATION.md.
 *
 * v0 → v1 (pre-release flat-out format fix):
 *   - `memory.longTerm.{backend,directory}` → `memory.longTermDirectory`
 *   - unknown keys (`runtime.maxStepsWithoutProgress`,
 *     `runtime.defaultWorkingDirectory`, `security.defaultPermissionLevel`,
 *     `security.maxCommandsPerMinute`, `logging.destination`,
 *     `memory.shortTerm`) are dropped with a warning list
 *   - result carries `configVersion: 1`
 */

import { isRecord } from "../utils/validation.ts";

/** Bump when a new migration step is added; update docs/MIGRATION.md. */
export const CONFIG_VERSION = 1;

export interface MigrationResult {
  readonly migrated: Record<string, unknown>;
  /** Human-readable notes about what changed (no values, only key paths). */
  readonly appliedMigrations: readonly string[];
  /** Recognized-but-obsolete keys that were removed. */
  readonly droppedKeys: readonly string[];
}

type MigrationStep = {
  readonly from: number;
  readonly to: number;
  readonly description: string;
  apply: (raw: Record<string, unknown>) => { patch: Record<string, unknown>; dropped: readonly string[] };
};

const MIGRATIONS: readonly MigrationStep[] = [
  {
    from: 0,
    to: 1,
    description: "flatten memory.longTerm.* → memory.longTermDirectory; drop obsolete keys",
    apply: (raw) => {
      const dropped: string[] = [];
      const out: Record<string, unknown> = structuredClone(raw);

      // memory.longTerm.directory → memory.longTermDirectory
      if (isRecord(out["memory"])) {
        const memory = { ...(out["memory"] as Record<string, unknown>) };
        if (isRecord(memory["longTerm"])) {
          const longTerm = memory["longTerm"] as Record<string, unknown>;
          if (typeof longTerm["directory"] === "string" && memory["longTermDirectory"] === undefined) {
            memory["longTermDirectory"] = longTerm["directory"];
          }
          delete memory["longTerm"];
        }
        if (memory["shortTerm"] !== undefined) {
          dropped.push("memory.shortTerm");
          delete memory["shortTerm"];
        }
        out["memory"] = memory;
      }

      for (const [section, key] of [
        ["runtime", "maxStepsWithoutProgress"],
        ["runtime", "defaultWorkingDirectory"],
        ["security", "defaultPermissionLevel"],
        ["security", "maxCommandsPerMinute"],
        ["logging", "destination"],
      ] as const) {
        if (isRecord(out[section])) {
          const obj = out[section] as Record<string, unknown>;
          if (obj[key] !== undefined) {
            dropped.push(`${section}.${key}`);
            delete obj[key];
          }
        }
      }

      return { patch: out, dropped };
    },
  },
];

/** Detect the file's version: explicit `configVersion`, else v0. */
export function detectConfigVersion(raw: unknown): number {
  if (isRecord(raw) && typeof raw["configVersion"] === "number" && Number.isInteger(raw["configVersion"]) && raw["configVersion"] >= 0) {
    return raw["configVersion"];
  }
  return 0;
}

/**
 * Migrate a raw config object to CURRENT. Idempotent: migrating an
 * already-current config returns it unchanged. Unknown *newer* versions are
 * returned untouched so old runtimes fail on validation, not on data loss.
 */
export function migrateRawConfig(raw: unknown): MigrationResult {
  if (!isRecord(raw)) {
    return { migrated: {}, appliedMigrations: [], droppedKeys: [] };
  }
  const hasVersionKey = raw["configVersion"] !== undefined;
  let version = detectConfigVersion(raw);
  let current: Record<string, unknown> = { ...raw };
  const applied: string[] = [];
  const dropped: string[] = [];

  if (version > CONFIG_VERSION) {
    // Future file: pass through; mergeConfig will validate.
    return { migrated: current, appliedMigrations: [], droppedKeys: [] };
  }

  for (const step of MIGRATIONS) {
    if (version < step.to) {
      const result = step.apply(current);
      current = result.patch;
      dropped.push(...result.dropped);
      applied.push(`v${version}→v${step.to}: ${step.description}`);
      version = step.to;
    }
  }

  if (applied.length > 0 || !hasVersionKey) {
    current["configVersion"] = CONFIG_VERSION;
  }
  return { migrated: current, appliedMigrations: applied, droppedKeys: dropped };
}
