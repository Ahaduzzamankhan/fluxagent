/**
 * FluxAgent — file controller.
 *
 * The HOW layer for filesystem operations. Tools/LLM never touch node:fs
 * directly; they call this controller. Every path flows through the sandbox
 * policy before touching the OS.
 */

import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";

import { FileNotFoundError, toFluxError } from "../utils/errors.ts";
import { isNonEmptyString } from "../utils/validation.ts";
import {
  enforcePathAllowed,
  type SandboxPolicy,
  DEFAULT_SANDBOX_POLICY,
} from "../security/sandbox.ts";

export interface FileControllerOptions {
  readonly sandboxPolicy?: SandboxPolicy;
  /** Default encoding for text reads/writes. */
  readonly encoding?: BufferEncoding;
}

export interface FileMetadata {
  readonly path: string;
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly accessedAt: string;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory" | "other";
  readonly size: number;
}

export interface FileSearchOptions {
  readonly maxResults?: number;
  readonly caseSensitive?: boolean;
  readonly maxFileBytes?: number;
}

export class FileController {
  private readonly policy: SandboxPolicy;
  private readonly encoding: BufferEncoding;

  constructor(options: FileControllerOptions = {}) {
    this.policy = options.sandboxPolicy ?? DEFAULT_SANDBOX_POLICY;
    this.encoding = options.encoding ?? "utf8";
  }

  // ── exists / metadata ────────────────────────────────────────────────────────

  async exists(p: string): Promise<boolean> {
    this.assertPath(p);
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async metadata(p: string): Promise<FileMetadata> {
    this.assertPath(p);
    const st = await fs.stat(p);
    return {
      path: p,
      size: st.size,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      createdAt: st.birthtime.toISOString(),
      modifiedAt: st.mtime.toISOString(),
      accessedAt: st.atime.toISOString(),
    };
  }

  // ── read / write / create / delete ───────────────────────────────────────────

  async readText(p: string, maxBytes?: number): Promise<string> {
    this.assertPath(p);
    if (maxBytes !== undefined) {
      const st = await fs.stat(p);
      if (st.size > maxBytes) {
        const handle = await fs.open(p, "r");
        try {
          const buf = Buffer.alloc(maxBytes);
          await handle.read(buf, 0, maxBytes, 0);
          return buf.toString(this.encoding);
        } finally {
          await handle.close();
        }
      }
    }
    return fs.readFile(p, this.encoding);
  }

  async readBytes(p: string, maxBytes?: number): Promise<Buffer> {
    this.assertPath(p);
    if (maxBytes === undefined) return fs.readFile(p);
    const st = await fs.stat(p);
    if (st.size <= maxBytes) return fs.readFile(p);
    const handle = await fs.open(p, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      await handle.read(buf, 0, maxBytes, 0);
      return buf;
    } finally {
      await handle.close();
    }
  }

  /** Write text; creates parent dirs when `createDirs` (default true). */
  async writeText(p: string, content: string, options: { createDirs?: boolean } = {}): Promise<{ bytesWritten: number }> {
    this.assertPath(p);
    if (options.createDirs !== false) {
      await fs.mkdir(path.dirname(p), { recursive: true });
    }
    const buf = Buffer.from(content, this.encoding);
    await fs.writeFile(p, buf);
    return { bytesWritten: buf.byteLength };
  }

  async writeBytes(p: string, content: Uint8Array, options: { createDirs?: boolean } = {}): Promise<{ bytesWritten: number }> {
    this.assertPath(p);
    if (options.createDirs !== false) {
      await fs.mkdir(path.dirname(p), { recursive: true });
    }
    await fs.writeFile(p, content);
    return { bytesWritten: content.byteLength };
  }

  /** Create an empty file or directory. Fails if it already exists. */
  async create(p: string, kind: "file" | "directory" = "file"): Promise<void> {
    this.assertPath(p);
    if (kind === "directory") {
      await fs.mkdir(p, { recursive: false });
      return;
    }
    const handle = await fs.open(p, "wx");
    await handle.close();
  }

  async delete(p: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.assertPath(p);
    const st = await fs.stat(p).catch(() => null);
    if (!st) throw FileNotFoundError(p);
    if (st.isDirectory()) {
      await fs.rm(p, { recursive: options.recursive ?? false });
    } else {
      await fs.unlink(p);
    }
  }

  // ── copy / move / rename ─────────────────────────────────────────────────────

  async copy(from: string, to: string, options: { overwrite?: boolean } = {}): Promise<void> {
    this.assertPath(from);
    this.assertPath(to);
    if (!options.overwrite && (await this.exists(to))) {
      const err = toFluxError(new Error(`Destination already exists: ${to}`));
      throw err;
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }

  async move(from: string, to: string): Promise<void> {
    this.assertPath(from);
    this.assertPath(to);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
  }

  async rename(from: string, to: string): Promise<void> {
    return this.move(from, to);
  }

  // ── list / search ────────────────────────────────────────────────────────────

  async list(p: string, options: { recursive?: boolean; maxEntries?: number } = {}): Promise<DirectoryEntry[]> {
    this.assertPath(p);
    const max = options.maxEntries ?? 5000;
    const out: DirectoryEntry[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= max) return;
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      for (const d of dirents) {
        if (out.length >= max) return;
        const full = path.join(dir, d.name);
        const kind: DirectoryEntry["kind"] = d.isFile() ? "file" : d.isDirectory() ? "directory" : "other";
        let size = 0;
        try {
          size = kind === "file" ? (await fs.stat(full)).size : 0;
        } catch {
          size = 0;
        }
        out.push({ name: d.name, path: full, kind, size });
        if (options.recursive && d.isDirectory()) await walk(full, depth + 1);
      }
    };

    await walk(p, 0);
    return out;
  }

  /** Search file *names* and (for text files) contents under a root. */
  async search(root: string, query: string, options: FileSearchOptions = {}): Promise<DirectoryEntry[]> {
    this.assertPath(root);
    if (!isNonEmptyString(query)) throw new Error("search query must be non-empty");
    const maxResults = options.maxResults ?? 100;
    const caseSensitive = options.caseSensitive ?? false;
    const maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    const needle = caseSensitive ? query : query.toLowerCase();
    const entries = await this.list(root, { recursive: true, maxEntries: 20_000 });
    const matches: DirectoryEntry[] = [];
    for (const e of entries) {
      if (matches.length >= maxResults) break;
      const nameMatch = caseSensitive ? e.name.includes(needle) : e.name.toLowerCase().includes(needle);
      if (nameMatch) {
        matches.push(e);
        continue;
      }
      if (e.kind === "file" && e.size <= maxFileBytes) {
        try {
          const content = await fs.readFile(e.path, this.encoding);
          const hay = caseSensitive ? content : content.toLowerCase();
          if (hay.includes(needle)) matches.push(e);
        } catch {
          // unreadable (binary/permission): skip
        }
      }
    }
    return matches;
  }

  // ── guards ───────────────────────────────────────────────────────────────────

  /** Sandbox gate — every mutating/reading op routes through here. */
  private assertPath(p: string): void {
    if (!isNonEmptyString(p)) throw new Error("path must be a non-empty string");
    enforcePathAllowed(p, this.policy);
  }
}

export { FileNotFoundError };
export { fsConstants };
