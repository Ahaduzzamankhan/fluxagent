/**
 * FluxAgent — observation engine.
 *
 * Enriches raw tool observations with structured analysis: what changed, what
 * side effects are visible, what evidence supports the result. The brain
 * reasons from these enriched records — never from the assumption that a
 * tool "probably worked".
 */

import type { Observation } from "./state.ts";
import type { Logger } from "../utils/logger.ts";

export type EvidenceKind =
  | "output-field"
  | "output-missing"
  | "error-payload"
  | "duration-anomaly"
  | "side-effect";

export interface Evidence {
  readonly kind: EvidenceKind;
  readonly detail: string;
  readonly weight: "strong" | "weak" | "negative";
}

export type StateChangeClass =
  | "filesystem"
  | "process"
  | "window"
  | "input"
  | "screen"
  | "system"
  | "network"
  | "memory"
  | "unknown";

export interface StateChange {
  readonly domain: StateChangeClass;
  readonly description: string;
  /** "target" of the change when known (path, pid, title...). */
  readonly target?: string;
}

export interface SideEffect {
  readonly description: string;
  readonly severity: "informational" | "warning";
}

export interface EnrichedObservation {
  readonly observation: Observation;
  readonly success: boolean;
  readonly stateChanges: readonly StateChange[];
  readonly sideEffects: readonly SideEffect[];
  readonly evidence: readonly Evidence[];
  readonly summary: string;
  readonly at: string;
}

// Tool-prefix → domain mapping for change classification.
const TOOL_DOMAIN: readonly { prefix: string; domain: StateChangeClass }[] = [
  { prefix: "file.", domain: "filesystem" },
  { prefix: "command.", domain: "process" },
  { prefix: "process.", domain: "process" },
  { prefix: "app.", domain: "window" },
  { prefix: "keyboard.", domain: "input" },
  { prefix: "mouse.", domain: "input" },
  { prefix: "screen.", domain: "screen" },
  { prefix: "system.", domain: "system" },
  { prefix: "python.", domain: "memory" },
];

function domainFor(toolName: string): StateChangeClass {
  return TOOL_DOMAIN.find((t) => toolName.startsWith(t.prefix))?.domain ?? "unknown";
}

/** Tools whose success implies a world mutation worth recording. */
const MUTATING_PREFIXES = new Set(["file.", "command.", "process.", "app.", "keyboard.", "mouse."]);

export interface ObservationEngineOptions {
  readonly logger?: Logger;
  /** Duration above which an observation is flagged (per tool, ms). */
  readonly slowToolThresholdMs?: number;
}

export class ObservationEngine {
  private readonly logger?: Logger;
  private readonly slowThresholdMs: number;
  private readonly enriched: EnrichedObservation[] = [];

  constructor(options: ObservationEngineOptions = {}) {
    this.logger = options.logger;
    this.slowToolThresholdMs = options.slowToolThresholdMs ?? 30_000;
  }

  /** Analyze one observation into an enriched record. Pure analysis. */
  enrich(obs: Observation): EnrichedObservation {
    const evidence: Evidence[] = [];
    const stateChanges: StateChange[] = [];
    const sideEffects: SideEffect[] = [];

    if (obs.ok) {
      const out = obs.output as Record<string, unknown> | undefined;
      if (out && typeof out === "object") {
        for (const [k, v] of Object.entries(out)) {
          evidence.push({
            kind: "output-field",
            detail: `${k}=${typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80)}`,
            weight: "strong",
          });
        }
        // Known success markers.
        if (out.created === true) stateChanges.push({ domain: domainFor(obs.toolName), description: "created target", target: String(out.path ?? "") });
        if (out.deleted === true) stateChanges.push({ domain: domainFor(obs.toolName), description: "deleted target", target: String(out.path ?? "") });
        if (out.moved === true || out.copied === true || out.renamed === true) {
          stateChanges.push({ domain: domainFor(obs.toolName), description: "relocated target", target: `${String(out.from ?? "")} -> ${String(out.to ?? "")}` });
        }
        if (out.pid !== undefined) stateChanges.push({ domain: "process", description: "process involved", target: String(out.pid) });
        if (out.terminated === true) stateChanges.push({ domain: "process", description: "process terminated", target: String(out.pid ?? "") });
        // Any successful mutating tool implies a world change, even without
        // explicit markers — record it so downstream verification has evidence.
        if (stateChanges.length === 0 && MUTATING_PREFIXES.has(obs.toolName.split(".")[0]! + ".")) {
          const target = typeof out.path === "string" ? out.path : typeof out.pid !== "undefined" ? String(out.pid) : undefined;
          stateChanges.push({ domain: domainFor(obs.toolName), description: `mutating tool ${obs.toolName} reported success`, ...(target !== undefined ? { target } : {}) });
        }
      } else {
        evidence.push({ kind: "output-missing", detail: "no structured output captured", weight: "weak" });
      }
      if (obs.durationMs > this.slowToolThresholdMs) {
        evidence.push({ kind: "duration-anomaly", detail: `slow execution: ${Math.round(obs.durationMs)}ms`, weight: "weak" });
        sideEffects.push({ description: `tool ran long (${Math.round(obs.durationMs)}ms) — possible hang`, severity: "warning" });
      }
    } else if (obs.error) {
      evidence.push({ kind: "error-payload", detail: `${obs.error.code}: ${obs.error.message}`, weight: "negative" });
      if (obs.error.hint) evidence.push({ kind: "error-payload", detail: `hint: ${obs.error.hint}`, weight: "weak" });
    }

    // Mutating tools that failed may still have had partial effects.
    if (!obs.ok && MUTATING_PREFIXES.has(obs.toolName.split(".")[0]! + ".")) {
      sideEffects.push({
        description: `failed mutating tool (${obs.toolName}) may have left partial changes — verify state before proceeding`,
        severity: "warning",
      });
    }

    const summary = obs.ok
      ? `${obs.toolName} succeeded${stateChanges.length ? `: ${stateChanges.map((c) => c.description).join(", ")}` : ""}`
      : `${obs.toolName} failed: ${obs.error?.message ?? "unknown"}`;

    const enrichedObs: EnrichedObservation = {
      observation: obs,
      success: obs.ok,
      stateChanges,
      sideEffects,
      evidence,
      summary,
      at: new Date().toISOString(),
    };
    this.enriched.push(enrichedObs);
    this.logger?.debug("observation enriched", { tool: obs.toolName, ok: obs.ok, changes: stateChanges.length });
    return enrichedObs;
  }

  /** Recent enriched records (bounded window). */
  recent(limit = 10): readonly EnrichedObservation[] {
    return this.enriched.slice(-limit);
  }

  /** All recorded side effects — used by verification and self-evaluation. */
  allSideEffects(): readonly SideEffect[] {
    return this.enriched.flatMap((e) => e.sideEffects);
  }
}
