/**
 * FluxAgent — dynamic tool discovery.
 *
 * Tools are not all exposed to every model call. Discovery selects tools by
 * required capabilities, category, and permission envelope. Enriched metadata
 * (category, risk, availability) rides on top of the existing ToolInfo.
 */

import type { ToolRegistry } from "./registry.ts";
import type { ToolInfo } from "./tool.ts";
import type { PermissionLevel } from "./permissions.ts";
import { permissionRank } from "./permissions.ts";

// ─── Enriched metadata ────────────────────────────────────────────────────────

export type ToolCategory =
  | "filesystem"
  | "command"
  | "process"
  | "screen"
  | "input"
  | "application"
  | "system"
  | "network"
  | "python"
  | "agent"
  | "general";

export type ToolRisk = "none" | "low" | "medium" | "high";

export interface ToolCapabilityProfile {
  readonly category: ToolCategory;
  readonly risk: ToolRisk;
  /** Capability tags, e.g. ["read-text", "write-text", "list-directory"]. */
  readonly capabilities: readonly string[];
  /** Whether the tool is currently usable (backend present, etc.). */
  readonly available: boolean;
  readonly unavailableReason?: string;
}

const CATEGORY_BY_PREFIX: readonly { prefix: string; category: ToolCategory }[] = [
  { prefix: "file.", category: "filesystem" },
  { prefix: "command.", category: "command" },
  { prefix: "process.", category: "process" },
  { prefix: "screen.", category: "screen" },
  { prefix: "keyboard.", category: "input" },
  { prefix: "mouse.", category: "input" },
  { prefix: "app.", category: "application" },
  { prefix: "system.", category: "system" },
  { prefix: "python.", category: "python" },
  { prefix: "agent.", category: "agent" },
];

export function categoryFor(toolName: string): ToolCategory {
  return CATEGORY_BY_PREFIX.find((c) => toolName.startsWith(c.prefix))?.category ?? "general";
}

/** Risk from permission level (consistent with the decision engine). */
export function riskForLevel(level: PermissionLevel): ToolRisk {
  switch (level) {
    case "READ_ONLY": return "low";
    case "SAFE_WRITE": return "medium";
    case "USER_CONFIRMATION": return "medium";
    case "PRIVILEGED": return "high";
  }
}

/** Infer capability tags from the tool's input schema + name. */
export function inferCapabilities(info: ToolInfo): string[] {
  const caps: string[] = [];
  const props = info.inputSchema.properties ?? {};
  const op = info.name.split(".")[1] ?? "";
  caps.push(op || "invoke");
  if (props.path || props.from || props.to || props.root) caps.push("paths");
  if (props.pid) caps.push("pid");
  if (props.text) caps.push("text");
  if (info.permissionLevel === "READ_ONLY") caps.push("non-mutating");
  return caps;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

export interface DiscoveredTool {
  readonly info: ToolInfo;
  readonly profile: ToolCapabilityProfile;
}

export interface DiscoveryQuery {
  /** All tags must be present in the tool's capabilities. */
  readonly capabilities?: readonly string[];
  readonly category?: ToolCategory;
  /** Exclude tools above this permission level. */
  readonly maxPermission?: PermissionLevel;
  /** Exclude unavailable tools (default true). */
  readonly onlyAvailable?: boolean;
  readonly excludeDestructive?: boolean;
  readonly limit?: number;
}

export class ToolDiscovery {
  private readonly registry: ToolRegistry;
  /** Availability overrides keyed by tool name (injected by the runtime). */
  private readonly availability = new Map<string, { available: boolean; reason?: string }>();
  private profileCache = new Map<string, { info: ToolInfo; profile: ToolCapabilityProfile }>();

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /** Register availability (e.g. screen tools unavailable until a backend is wired). */
  setAvailability(toolName: string, available: boolean, reason?: string): void {
    this.availability.set(toolName, { available, reason });
    this.profileCache.delete(toolName);
  }

  /** Enriched view of one tool. */
  describe(toolName: string): DiscoveredTool | undefined {
    const info = this.registry.get(toolName)?.metadata;
    if (!info) return undefined;
    return { info, profile: this.profileFor(info) };
  }

  /** All tools matching the query. */
  discover(query: DiscoveryQuery = {}): DiscoveredTool[] {
    const onlyAvailable = query.onlyAvailable ?? true;
    let out = this.registry.list().map((info) => ({ info, profile: this.profileFor(info) }));

    if (query.category) out = out.filter((t) => t.profile.category === query.category);
    if (query.capabilities?.length) {
      out = out.filter((t) => query.capabilities!.every((c) => t.profile.capabilities.includes(c)));
    }
    if (query.maxPermission) {
      out = out.filter((t) => permissionRank(t.info.permissionLevel) <= permissionRank(query.maxPermission!));
    }
    if (query.excludeDestructive) {
      out = out.filter((t) => t.profile.risk !== "high" && !t.info.tags.includes("destructive"));
    }
    if (onlyAvailable) {
      out = out.filter((t) => t.profile.available);
    }
    if (query.limit) out = out.slice(0, query.limit);
    return out;
  }

  /** Tool descriptors shaped for the LLM (only what the query allows). */
  discoverForModel(query: DiscoveryQuery = {}): ToolInfo[] {
    return this.discover(query).map((t) => t.info);
  }

  private profileFor(info: ToolInfo): ToolCapabilityProfile {
    const cached = this.profileCache.get(info.name);
    if (cached) return cached.profile;
    const avail = this.availability.get(info.name);
    const profile: ToolCapabilityProfile = {
      category: categoryFor(info.name),
      risk: riskForLevel(info.permissionLevel),
      capabilities: inferCapabilities(info),
      available: avail?.available ?? true,
      ...(avail?.reason ? { unavailableReason: avail.reason } : {}),
    };
    this.profileCache.set(info.name, { info, profile });
    return profile;
  }
}
