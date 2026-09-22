/**
 * FluxAgent — context manager.
 *
 * Assembles the model-facing context under an explicit token-ish budget with
 * priority tiers. Never blindly truncates: low-priority content is compacted
 * (summarized/deduplicated) first, and critical constraints are always kept.
 *
 * Sections: system, task, plan, recent observations, relevant memory,
 * tool info, conversation history.
 */

import type { AgentState, Observation } from "./state.ts";
import type { ConversationTurn } from "../memory/memory.ts";
import type { ToolInfo } from "../tools/tool.ts";

export type ContextSection =
  | "system"
  | "task"
  | "plan"
  | "observations"
  | "memory"
  | "tools"
  | "conversation"
  | "unresolved";

export interface ContextItem {
  readonly section: ContextSection;
  readonly text: string;
  /** Higher priority survives compaction. 0..100. */
  readonly priority: number;
  /** Rough size estimate (chars). */
  readonly size: number;
  /** Critical items are never dropped or compacted. */
  readonly critical?: boolean;
}

export interface ContextBudget {
  /** Total char budget for the assembled context. */
  readonly maxChars: number;
  /** Per-section caps as fractions of the budget (0..1]. */
  readonly sectionCaps?: Partial<Record<ContextSection, number>>;
}

export const DEFAULT_BUDGET: ContextBudget = {
  maxChars: 24_000,
  sectionCaps: {
    observations: 0.25,
    conversation: 0.35,
    memory: 0.2,
    tools: 0.25,
  },
};

export interface AssembledContext {
  readonly blocks: readonly { section: ContextSection; text: string }[];
  readonly totalChars: number;
  readonly droppedSections: readonly ContextSection[];
  readonly compacted: boolean;
}

export interface ContextManagerOptions {
  readonly budget?: ContextBudget;
  /** Max observations kept verbatim; older ones are compacted into a digest. */
  readonly verbatimObservations?: number;
}

/** Compaction helpers — deterministic, no model calls. */
export function compactObservations(obs: readonly Observation[], keepVerbatim: number): ContextItem[] {
  const items: ContextItem[] = [];
  const recent = obs.slice(-keepVerbatim);
  for (const o of recent) {
    const body = o.ok
      ? JSON.stringify(o.output)?.slice(0, 240) ?? "(no output)"
      : `${o.error?.code}: ${o.error?.message}`;
    items.push({
      section: "observations",
      text: `[${o.toolName}] ${o.ok ? "ok" : "FAIL"} → ${body}`,
      priority: o.ok ? 55 : 90, // failures matter more
      size: 0,
    });
  }
  if (obs.length > keepVerbatim) {
    const older = obs.slice(0, -keepVerbatim);
    const fails = older.filter((o) => !o.ok);
    const digest =
      `[digest of ${older.length} older observations] ` +
      (fails.length
        ? `notable failures: ${fails.slice(-5).map((o) => `${o.toolName}:${o.error?.code ?? "?"}`).join(", ")}`
        : "all succeeded");
    items.unshift({ section: "observations", text: digest, priority: 35, size: 0 });
  }
  return items.map((i) => ({ ...i, size: i.text.length }));
}

export class ContextManager {
  private readonly budget: ContextBudget;
  private readonly verbatimObservations: number;

  constructor(options: ContextManagerOptions = {}) {
    this.budget = options.budget ?? DEFAULT_BUDGET;
    this.verbatimObservations = options.verbatimObservations ?? 6;
  }

  /**
   * Assemble the context for a model call.
   * Priority order (highest first): system > task > unresolved problems >
   * plan > failures > recent observations > memory > conversation > tools.
   */
  assemble(input: {
    systemPrompt: string;
    state: AgentState;
    conversation: readonly ConversationTurn[];
    memoryFacts: readonly string[];
    tools: readonly ToolInfo[];
    unresolvedProblems?: readonly string[];
    extraInstructions?: readonly string[];
  }): AssembledContext {
    const s = input.state;
    const items: ContextItem[] = [];

    // system — critical
    items.push({ section: "system", text: input.systemPrompt, priority: 100, size: input.systemPrompt.length, critical: true });

    // task — critical
    const taskText = `GOAL: ${s.goal}`;
    items.push({ section: "task", text: taskText, priority: 100, size: taskText.length, critical: true });

    // unresolved problems — critical (never lose open issues)
    for (const p of input.unresolvedProblems ?? []) {
      items.push({ section: "unresolved", text: `UNRESOLVED: ${p}`, priority: 95, size: p.length + 12, critical: true });
    }
    for (const e of s.errors.slice(-3)) {
      items.push({ section: "unresolved", text: `ERROR: ${e.code}: ${e.message}`, priority: 92, size: e.message.length + 10, critical: true });
    }

    // plan
    if (s.plan) {
      const lines = s.plan.steps.map(
        (st) => `- [${st.status}] ${st.title}${st.tool ? ` (tool: ${st.tool}${st.retryCount ? `, retries: ${st.retryCount}` : ""})` : ""}`,
      );
      const planText = `PLAN (rev ${s.plan.revision}, ${s.plan.summary}):\n${lines.join("\n")}`;
      items.push({ section: "plan", text: planText, priority: 85, size: planText.length });
    }

    // observations — with compaction
    items.push(...compactObservations(s.observations, this.verbatimObservations));

    // memory
    for (const fact of input.memoryFacts) {
      items.push({ section: "memory", text: `MEMORY: ${fact}`, priority: 50, size: fact.length + 8 });
    }

    // conversation (most recent, compacted older turns)
    const conv = input.conversation;
    const verbatimTurns = conv.slice(-6);
    for (const t of verbatimTurns) {
      const text = `${t.role}: ${t.content.slice(0, 500)}`;
      items.push({ section: "conversation", text, priority: 45, size: text.length });
    }
    if (conv.length > verbatimTurns.length) {
      const digest = `[${conv.length - verbatimTurns.length} earlier conversation turns omitted]`;
      items.push({ section: "conversation", text: digest, priority: 20, size: digest.length });
    }

    // tools
    const toolText = input.tools
      .map((t) => `- ${t.name} [${t.permissionLevel}]: ${t.description}`)
      .join("\n");
    if (toolText) {
      items.push({ section: "tools", text: `AVAILABLE TOOLS:\n${toolText}`, priority: 60, size: toolText.length });
    }

    for (const extra of input.extraInstructions ?? []) {
      items.push({ section: "system", text: extra, priority: 88, size: extra.length });
    }

    return this.fit(items);
  }

  /**
   * Fit items under budget: keep critical always; drop lowest-priority first;
   * compact observation digests if needed. Returns assembled blocks.
   */
  private fit(allItems: ContextItem[]): AssembledContext {
    // Pre-pass: sections that cannot fit whole are compacted to their digest
    // line(s) up front, so a single verbatim item can never crowd out the
    // summary of everything that was dropped.
    const items = this.preCompact(allItems);
    const sorted = [...items].sort((a, b) => b.priority - a.priority);
    const blocks: { section: ContextSection; text: string }[] = [];
    const dropped = new Set<ContextSection>();
    let total = 0;
    const usedBySection = new Map<ContextSection, number>();

    for (const item of sorted) {
      const cap = this.budget.sectionCaps?.[item.section];
      const capChars = cap !== undefined ? Math.floor(this.budget.maxChars * cap) : Infinity;
      const used = usedBySection.get(item.section) ?? 0;
      if (!item.critical && (total + item.size > this.budget.maxChars || used + item.size > capChars)) {
        dropped.add(item.section);
        continue;
      }
      blocks.push({ section: item.section, text: item.text });
      total += item.size;
      usedBySection.set(item.section, used + item.size);
    }

    // Fallback digests: a dropped section is summarized in one line instead of
    // vanishing silently — the model should at least know what it can't see.
    for (const sec of ["observations", "conversation", "plan", "memory", "tools"] as const) {
      if (!dropped.has(sec)) continue;
      const summary = this.sectionDigest(sec, items);
      if (!summary) continue;
      const cap = this.budget.sectionCaps?.[sec];
      const capChars = cap !== undefined ? Math.floor(this.budget.maxChars * cap) : Infinity;
      if (total + summary.length <= this.budget.maxChars && summary.length <= capChars) {
        blocks.push({ section: sec, text: summary });
        total += summary.length;
      }
    }

    // Preserve original section order for readability.
    const order: ContextSection[] = ["system", "task", "unresolved", "plan", "observations", "memory", "conversation", "tools"];
    const ordered = order
      .map((sec) => blocks.filter((b) => b.section === sec))
      .filter((arr) => arr.length > 0)
      .map((arr) => ({ section: arr[0]!.section, texts: arr.map((b) => b.text) }))
      .map((g) => ({ section: g.section, text: g.texts.join("\n") }));

    const compacted = dropped.size > 0;
    return {
      blocks: ordered,
      totalChars: ordered.reduce((n, b) => n + b.text.length, 0),
      droppedSections: [...dropped],
      compacted,
    };
  }

  /**
   * If a section's non-critical items exceed its cap (or a fair share of the
   * total budget), replace the verbatim items with the precomputed digest and
   * keep only as many verbatim items as fit afterwards.
   */
  private preCompact(items: readonly ContextItem[]): ContextItem[] {
    const sections = new Set(items.map((i) => i.section));
    let out = [...items];
    for (const sec of sections) {
      const cap = this.budget.sectionCaps?.[sec];
      const capChars = cap !== undefined ? Math.floor(this.budget.maxChars * cap) : this.budget.maxChars;
      const secItems = out.filter((i) => i.section === sec && !i.critical);
      const secTotal = secItems.reduce((n, i) => n + i.size, 0);
      if (secTotal <= capChars) continue;
      const digest = secItems.find((i) => i.text.startsWith("[digest of") || i.text.startsWith("["));
      const digestSize = digest?.size ?? 0;
      const budgetForVerbatim = Math.max(0, capChars - digestSize);
      const keep: ContextItem[] = [];
      let used = 0;
      // Highest-priority verbatim items first (failures outrank successes).
      for (const i of [...secItems].filter((i) => i !== digest).sort((a, b) => b.priority - a.priority)) {
        if (used + i.size > budgetForVerbatim) break;
        keep.push(i);
        used += i.size;
      }
      const rest = out.filter((i) => i.section !== sec);
      out = [...rest, ...(digest ? [digest] : []), ...keep];
    }
    return out;
  }

  /** One-line digest for a section whose items could not fit. */
  private sectionDigest(sec: ContextSection, allItems: readonly ContextItem[]): string | null {
    const secItems = allItems.filter((i) => i.section === sec && !i.critical);
    if (secItems.length === 0) return null;
    if (sec === "observations") {
      // Prefer the precomputed digest from compactObservations when it fits.
      const digest = secItems.find((i) => i.text.startsWith("[digest of"));
      if (digest && digest.size <= 220) return digest.text;
      return `[${secItems.length} observations compacted]`;
    }
    if (sec === "conversation") return `[${secItems.filter((i) => !i.text.startsWith("[")).length} conversation turns compacted]`;
    if (sec === "tools") return `[${secItems.length} tool descriptions omitted]`;
    if (sec === "plan") return `[plan omitted]`;
    if (sec === "memory") return `[${secItems.length} memory facts omitted]`;
    return null;
  }
}

/** Render an AssembledContext into a single prompt string. */
export function renderContext(ctx: AssembledContext): string {
  const headers: Record<ContextSection, string> = {
    system: "SYSTEM",
    task: "TASK",
    plan: "PLAN",
    observations: "OBSERVATIONS",
    memory: "MEMORY",
    tools: "TOOLS",
    conversation: "CONVERSATION",
    unresolved: "UNRESOLVED",
  };
  return ctx.blocks.map((b) => `## ${headers[b.section]}\n${b.text}`).join("\n\n");
}
