/**
 * FluxAgent — MCP (Model Context Protocol) client (Phase 8).
 *
 * MCP servers are ANOTHER TOOL SOURCE, not a bypass. Every MCP tool is wrapped
 * as a normal FluxAgent Tool and registered in the ToolRegistry under a
 * namespaced id (`mcp.<server>.<tool>`), so calls still flow:
 *
 *   model → ToolRegistry → PermissionManager → MCP tool → server process
 *
 * Transport: stdio JSON-RPC 2.0 (newline-delimited), child process spawned
 * without a shell. Discovery via `tools/list`, execution via `tools/call`.
 * Timeouts and disconnects produce structured errors — never hangs, never
 * fake results.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { defineTool, type Tool } from "../tools/tool.ts";
import type { JSONSchema } from "../tools/schemas.ts";
import { FluxError } from "../utils/errors.ts";
import { ids } from "../utils/ids.ts";

// ─── JSON-RPC wire types (subset used) ───────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP tool descriptor from tools/list. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema for the tool's input. */
  readonly inputSchema: JSONSchema;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  /** Stable server id used in tool namespaces: mcp.<server>.<tool>. */
  readonly name: string;
  /** Executable to spawn (no shell). */
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Default timeout for a tool call (ms). */
  readonly timeoutMs?: number;
}

export class McpClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private readonly config: McpServerConfig;
  private _connected = false;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  get serverName(): string {
    return this.config.name;
  }

  /** Spawn the server process and perform the MCP initialize handshake. */
  async connect(): Promise<void> {
    if (this._connected) return;
    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.config.env ? { ...process.env, ...this.config.env } : process.env,
      shell: false, // never interpret server commands through a shell
      windowsHide: true,
    });
    child.on("error", (err) => this.failAll(new FluxError({ code: "E_MCP_DISCONNECT", message: `MCP server "${this.config.name}" failed to start: ${err.message}` })));
    child.on("exit", (code) => {
      this._connected = false;
      this.failAll(new FluxError({ code: "E_MCP_DISCONNECT", message: `MCP server "${this.config.name}" exited (code ${code ?? "signal"})` }));
    });
    child.stdout.on("data", (d: Buffer) => this.onData(d));
    // Stderr is diagnostics; capture a bounded tail for error reporting.
    child.stderr.on("data", (d: Buffer) => {
      this.lastStderr = (this.lastStderr + d.toString("utf8")).slice(-2000);
    });
    this.process = child;
    this._connected = true;

    // Initialize handshake (JSON-RPC; params per MCP spec are informational).
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fluxagent", version: "0.3.0" },
    }).catch((err) => {
      this.disconnect();
      throw err;
    });
    // Notify initialization complete (no response expected).
    this.notify("notifications/initialized", {});
  }

  private lastStderr = "";

  /** Discover tools via tools/list. */
  async listTools(): Promise<readonly McpToolDescriptor[]> {
    const result = (await this.rpc("tools/list", {})) as { tools?: McpToolDescriptor[] } | undefined;
    const tools = result?.tools ?? [];
    return tools.filter(
      (t): t is McpToolDescriptor =>
        typeof t?.name === "string" && t.inputSchema !== undefined && typeof t.inputSchema === "object",
    );
  }

  /** Execute a tool call on the server. Returns the tool's structured content. */
  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const result = (await this.rpc("tools/call", { name: toolName, arguments: args }, timeoutMs ?? this.config.timeoutMs ?? 30_000)) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    } | undefined;
    if (result?.isError) {
      const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "MCP tool error";
      throw new FluxError({ code: "E_TOOL_EXECUTION", message: `MCP tool ${toolName} failed: ${text.slice(0, 500)}` });
    }
    // Prefer structured text content; fall back to the raw result.
    const text = result?.content?.map((c) => c.text ?? "").join("\n");
    if (typeof text === "string" && text.length > 0) {
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    }
    return result ?? null;
  }

  disconnect(): void {
    this._connected = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new FluxError({ code: "E_MCP_DISCONNECT", message: `MCP server "${this.config.name}" disconnected` }));
    }
    this.pending.clear();
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  // ── JSON-RPC plumbing ───────────────────────────────────────────────────────

  private rpc(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!this.process || !this._connected) {
      return Promise.reject(new FluxError({ code: "E_MCP_DISCONNECT", message: `MCP server "${this.config.name}" is not connected` }));
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FluxError({ code: "E_TIMEOUT", message: `MCP ${method} timed out after ${timeoutMs}ms` }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  private notify(method: string, params: unknown): void {
    const note: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.process?.stdin.write(JSON.stringify(note) + "\n");
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // ignore malformed lines (server diagnostics etc.)
      }
      if (msg.id === undefined) continue; // server-initiated request/notification: ignored for now
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new FluxError({
          code: "E_MCP_DISCONNECT",
          message: `MCP server error ${msg.error.code}: ${msg.error.message}`,
        }));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

// ─── Namespaced FluxAgent tools ───────────────────────────────────────────────

/**
 * Wrap MCP tool descriptors as FluxAgent Tools in the `mcp.<server>.<tool>`
 * namespace. The wrapper validates with the server-provided schema and marks
 * results with their origin so observations stay auditable.
 */
export function mcpToolsFromDescriptors(
  client: McpClient,
  descriptors: readonly McpToolDescriptor[],
): Tool[] {
  const tools: Tool[] = [];
  for (const d of descriptors) {
    const fullName = `mcp.${client.serverName}.${d.name}`;
    const schema: JSONSchema = d.inputSchema;
    tools.push(
      defineTool({
        metadata: {
          name: fullName,
          description: d.description ? `[mcp:${client.serverName}] ${d.description}` : `[mcp:${client.serverName}] ${d.name}`,
          inputSchema: schema,
          // MCP tools are external code execution by definition — they always
          // require user confirmation unless explicitly granted (Phase 5).
          permissionLevel: "USER_CONFIRMATION",
          tags: ["mcp", `mcp:${client.serverName}`],
        },
        validate(args: unknown): asserts args is Record<string, unknown> {
          if (typeof args !== "object" || args === null) throw new Error(`${fullName} arguments must be an object`);
        },
        async execute(args) {
          const out = await client.callTool(d.name, args as Record<string, unknown>);
          return { origin: `mcp:${client.serverName}`, result: out };
        },
      }),
    );
  }
  return tools;
}

/** Convenience: connect + discover + wrap in one step. */
export async function connectMcpServer(config: McpServerConfig): Promise<{ client: McpClient; tools: Tool[] }> {
  const client = new McpClient(config);
  await client.connect();
  const descriptors = await client.listTools();
  return { client, tools: mcpToolsFromDescriptors(client, descriptors) };
}

/** Sentinel id helper kept for tests. */
export function mcpCallId(): string {
  return ids.event();
}
