/**
 * FluxAgent — plugin system (Phase 12).
 *
 * Plugins extend FluxAgent without touching the core: tools, event handlers,
 * model providers, and memory providers, declared in a validated manifest.
 *
 * Lifecycle (12.2): discover → validate → load → initialize → enable →
 * disable → unload. A plugin must pass through each state; illegal jumps are
 * rejected. Permissions (12.3): a plugin's declared tools go through the SAME
 * ToolRegistry + PermissionManager path as built-ins — no elevated access by
 * default; the manifest's requested permission levels are clamped by the
 * session ceiling at registration.
 *
 * Developer SDK (12.4): implement `FluxPlugin` + the contribute factories;
 * compatibility (12.5) is enforced from manifest.apiVersion.
 */

import type { Tool, ToolInfo } from "../tools/tool.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { PermissionLevel } from "../tools/permissions.ts";
import { isPermissionLevel, permissionRank } from "../tools/permissions.ts";
import type { EventBus, EventPattern } from "../events/event-bus.ts";
import type { AgentEvent } from "../events/events.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { ModelGateway } from "../api/gateway.ts";
import type { Logger } from "../utils/logger.ts";
import { validatePluginManifest, type PluginManifest } from "../security/audit.ts";

export const PLUGIN_API_VERSION = "1";

// ─── Developer SDK interfaces (12.4) ──────────────────────────────────────────

export interface PluginContext {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  /** Ceiling the plugin's tools will be clamped to. */
  readonly permissionCeiling: PermissionLevel;
  /** Storage area namespaced per plugin (13.5 storage seam). */
  readonly storage: PluginStorage;
}

export interface FluxPlugin {
  readonly manifest: PluginManifest;
  initialize(context: PluginContext): Promise<void>;
  /** Build the tools this plugin contributes (called after initialize). */
  contributeTools?(): readonly Tool[];
  /** Register event handlers; returns unregister functions. */
  contributeEventHandlers?(bus: EventBus): readonly (() => void)[];
  /** Contribute a model provider adapter (registered into the gateway). */
  contributeModelProvider?(): LlmProvider | null;
  dispose?(): Promise<void>;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export type PluginLifecycleState =
  | "discovered" | "validated" | "loaded" | "initialized"
  | "enabled" | "disabled" | "unloaded" | "rejected";

export interface PluginRecord {
  readonly manifest: PluginManifest;
  state: PluginLifecycleState;
  readonly loadedAt?: string;
  error?: string;
}

export interface PluginManagerOptions {
  readonly registry: ToolRegistry;
  readonly eventBus: EventBus;
  readonly gateway?: ModelGateway;
  readonly logger?: Logger;
  readonly storage: PluginStorage;
  /** Hard ceiling applied to plugin-declared permission levels. */
  readonly permissionCeiling: PermissionLevel;
}

export interface PluginStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Namespaced in-memory storage behind the 13.5 Storage interface shape. */
export class InMemoryPluginStorage implements PluginStorage {
  private readonly data = new Map<string, string>();
  private readonly namespace: string;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  async get(key: string): Promise<string | null> {
    return this.data.get(this.key(key)) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(this.key(key), value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(this.key(key));
  }
}

export class PluginManager {
  private readonly plugins = new Map<string, { record: PluginRecord; plugin: FluxPlugin }>();
  private readonly opts: PluginManagerOptions;
  private readonly logger?: Logger;

  constructor(options: PluginManagerOptions) {
    this.opts = options;
    this.logger = options.logger;
  }

  /** 12.2 discover: accept a candidate manifest; validate before load. */
  discover(manifest: unknown, plugin: FluxPlugin): PluginRecord {
    const validation = validatePluginManifest(manifest);
    if (!validation.ok || !validation.manifest) {
      const record: PluginRecord = {
        manifest: { name: "invalid", version: "0.0.0", apiVersion: PLUGIN_API_VERSION, contributes: {} },
        state: "rejected",
        error: validation.reason,
      };
      this.logger?.warn("plugin rejected at discovery", { reason: validation.reason });
      return record;
    }
    if (validation.manifest.apiVersion !== PLUGIN_API_VERSION) {
      const record: PluginRecord = {
        manifest: validation.manifest,
        state: "rejected",
        error: `plugin apiVersion "${validation.manifest.apiVersion}" incompatible with runtime ${PLUGIN_API_VERSION}`,
      };
      return record;
    }
    if (this.plugins.has(validation.manifest.name)) {
      const record: PluginRecord = {
        manifest: validation.manifest,
        state: "rejected",
        error: `plugin name already registered: ${validation.manifest.name}`,
      };
      return record;
    }
    const record: PluginRecord = { manifest: validation.manifest, state: "validated" };
    this.plugins.set(validation.manifest.name, { record, plugin });
    return record;
  }

  /** load → initialize → enable. Throws on invalid transitions. */
  async enable(name: string): Promise<PluginRecord> {
    const entry = this.plugins.get(name);
    if (!entry) throw new Error(`unknown plugin: ${name}`);
    const { record, plugin } = entry;

    if (record.state !== "validated" && record.state !== "disabled") {
      throw new Error(`cannot enable plugin "${name}" from state "${record.state}"`);
    }

    if (record.state === "validated") {
      const context: PluginContext = {
        logger: (this.logger ?? console).child?.("plugin:" + name) ?? (this.logger as Logger | undefined) ?? consoleAsLogger(),
        eventBus: this.opts.eventBus,
        permissionCeiling: this.opts.permissionCeiling,
        storage: new InMemoryPluginStorage(name),
      };
      await plugin.initialize(context);
      record.loadedAt = new Date().toISOString();
      record.state = "initialized";

      // Tools: registered into the normal registry with CLAMPED levels.
      const contributed = plugin.contributeTools?.() ?? [];
      for (const tool of contributed) {
        this.opts.registry.register(clampTool(tool, this.opts.permissionCeiling, name));
      }
      // Event handlers: same bus, scoped handlers.
      plugin.contributeEventHandlers?.(this.opts.eventBus);
      // Model providers: registered into the gateway like built-ins.
      const provider = plugin.contributeModelProvider?.();
      if (provider && this.opts.gateway) {
        this.opts.gateway.registerProvider(provider);
      }
    }

    record.state = "enabled";
    this.logger?.info("plugin enabled", { plugin: name });
    return record;
  }

  /** disable → dispose. Tools stay registered but are marked; state machine enforced. */
  async disable(name: string): Promise<PluginRecord> {
    const entry = this.plugins.get(name);
    if (!entry) throw new Error(`unknown plugin: ${name}`);
    if (entry.record.state !== "enabled") {
      throw new Error(`cannot disable plugin "${name}" from state "${entry.record.state}"`);
    }
    await entry.plugin.dispose?.();
    entry.record.state = "disabled";
    this.logger?.info("plugin disabled", { plugin: name });
    return entry.record;
  }

  /** Full unload: disable (if needed) + remove from the manager. */
  async unload(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) return;
    if (entry.record.state === "enabled") await this.disable(name);
    this.plugins.delete(name);
  }

  list(): readonly { name: string; version: string; state: PluginLifecycleState; error?: string }[] {
    return [...this.plugins.values()].map(({ record }) => ({
      name: record.manifest.name,
      version: record.manifest.version,
      state: record.state,
      ...(record.error ? { error: record.error } : {}),
    }));
  }

  get(name: string): PluginRecord | undefined {
    return this.plugins.get(name)?.record;
  }

  /** Tool descriptors contributed by enabled plugins (for UIs). */
  pluginToolInfos(): readonly { plugin: string; tools: readonly ToolInfo[] }[] {
    return [...this.plugins.values()]
      .filter(({ record }) => record.state === "enabled")
      .map(({ record, plugin }) => ({
        plugin: record.manifest.name,
        tools: (plugin.contributeTools?.() ?? []).map((t) => t.metadata),
      }));
  }
}

/** Clamp a plugin tool's permission level to the ceiling; namespaced name. */
function clampTool(tool: Tool, ceiling: PermissionLevel, pluginName: string): Tool {
  const level: PermissionLevel = isPermissionLevel(tool.metadata.permissionLevel)
    ? tool.metadata.permissionLevel
    : "USER_CONFIRMATION";
  const clamped: PermissionLevel = permissionRank(level) > permissionRank(ceiling) ? ceiling : level;
  const meta = tool.metadata;
  return {
    metadata: {
      ...meta,
      name: `plugin.${pluginName}.${meta.name}`,
      permissionLevel: clamped,
      tags: [...meta.tags, "plugin", `plugin:${pluginName}`],
    },
    validate: tool.validate.bind(tool),
    execute: tool.execute.bind(tool),
  };
}

function consoleAsLogger(): Logger {
  return {
    child: () => consoleAsLogger(),
    debug: () => {},
    info: (message: string) => console.log(`[plugin] ${message}`),
    warn: (message: string) => console.warn(`[plugin] ${message}`),
    error: (message: string) => console.error(`[plugin] ${message}`),
  } as unknown as Logger;
}

export type { EventPattern, AgentEvent };
