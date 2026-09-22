/**
 * FluxAgent — built-in file tools.
 *
 * Each tool wraps exactly one FileController capability. Permission levels
 * follow the spec: reads = READ_ONLY, writes = SAFE_WRITE, deletes =
 * USER_CONFIRMATION.
 */

import { S, validateAgainstSchema, type JSONSchema } from "../schemas.ts";
import { defineTool, type Tool } from "../tool.ts";
import { FileNotFoundError } from "../../utils/errors.ts";
import type { FileController, DirectoryEntry } from "../../controllers/files.ts";

// ── schema builders ───────────────────────────────────────────────────────────

const pathArg = (desc: string): JSONSchema => S.string(desc, { minLength: 1 });

const readArgs = S.object({ path: pathArg("File path to read"), maxBytes: S.integer("Optional read cap in bytes") }, ["path"]);
const writeArgs = S.object(
  {
    path: pathArg("File path to write"),
    content: S.string("Text content to write"),
    createDirs: S.boolean("Create parent directories (default true)"),
  },
  ["path", "content"],
);
const createArgs = S.object(
  { path: pathArg("Path to create"), kind: S.enum(["file", "directory"], "What to create") },
  ["path", "kind"],
);
const deleteArgs = S.object({ path: pathArg("Path to delete"), recursive: S.boolean("Recurse into directories") }, ["path"]);
const copyArgs = S.object({ from: pathArg("Source"), to: pathArg("Destination"), overwrite: S.boolean("Overwrite destination") }, ["from", "to"]);
const moveArgs = S.object({ from: pathArg("Source"), to: pathArg("Destination") }, ["from", "to"]);
const renameArgs = S.object({ from: pathArg("Current path"), to: pathArg("New name/path") }, ["from", "to"]);
const existsArgs = S.object({ path: pathArg("Path to test") }, ["path"]);
const listArgs = S.object(
  { path: pathArg("Directory to list"), recursive: S.boolean("Recurse (default false)"), maxEntries: S.integer("Max entries (default 5000)") },
  ["path"],
);
const searchArgs = S.object(
  {
    root: pathArg("Directory root for the search"),
    query: S.string("Search text (names and file contents)"),
    maxResults: S.integer("Max matches (default 100)"),
  },
  ["root", "query"],
);
const metadataArgs = S.object({ path: pathArg("Path to inspect") }, ["path"]);

function validated<T>(schema: JSONSchema, args: unknown): asserts args is T {
  const res = validateAgainstSchema<T>(schema, args);
  if (!res.valid) throw new Error(res.issues.join("; "));
}

// ── tools ─────────────────────────────────────────────────────────────────────

export function createFileTools(files: FileController): Tool[] {
  const read = defineTool({
    metadata: {
      name: "file.read",
      description: "Read a text file with optional byte cap.",
      inputSchema: readArgs,
      permissionLevel: "READ_ONLY",
      tags: ["fs"],
    },
    validate(args: unknown): asserts args is { path: string; maxBytes?: number } {
      validated(readArgs, args);
    },
    async execute(args, ctx) {
      if (!(await files.exists(args.path))) throw new FileNotFoundError(args.path);
      const content = await files.readText(args.path, args.maxBytes);
      return { path: args.path, bytes: Buffer.byteLength(content), content };
    },
  });

  const write = defineTool({
    metadata: {
      name: "file.write",
      description: "Write text to a file (creates parents by default).",
      inputSchema: writeArgs,
      permissionLevel: "SAFE_WRITE",
      tags: ["fs"],
    },
    validate(args: unknown): asserts args is { path: string; content: string; createDirs?: boolean } {
      validated(writeArgs, args);
    },
    async execute(args) {
      const res = await files.writeText(args.path, args.content, { createDirs: args.createDirs });
      return { path: args.path, bytesWritten: res.bytesWritten };
    },
  });

  const create = defineTool({
    metadata: {
      name: "file.create",
      description: "Create an empty file or a directory.",
      inputSchema: createArgs,
      permissionLevel: "SAFE_WRITE",
      tags: ["fs"],
    },
    validate(args: unknown): asserts args is { path: string; kind: "file" | "directory" } {
      validated(createArgs, args);
    },
    async execute(args) {
      await files.create(args.path, args.kind);
      return { path: args.path, kind: args.kind, created: true };
    },
  });

  const del = defineTool({
    metadata: {
      name: "file.delete",
      description: "Delete a file or directory (directory requires recursive=true).",
      inputSchema: deleteArgs,
      permissionLevel: "USER_CONFIRMATION",
      tags: ["fs", "destructive"],
    },
    validate(args: unknown): asserts args is { path: string; recursive?: boolean } {
      validated(deleteArgs, args);
    },
    async execute(args) {
      await files.delete(args.path, { recursive: args.recursive });
      return { path: args.path, deleted: true };
    },
  });

  const copy = defineTool({
    metadata: {
      name: "file.copy",
      description: "Copy a file.",
      inputSchema: copyArgs,
      permissionLevel: "SAFE_WRITE",
      tags: ["fs"],
    },
    validate(args: unknown): asserts args is { from: string; to: string; overwrite?: boolean } {
      validated(copyArgs, args);
    },
    async execute(args) {
      await files.copy(args.from, args.to, { overwrite: args.overwrite });
      return { from: args.from, to: args.to, copied: true };
    },
  });

  const move = defineTool({
    metadata: {
      name: "file.move",
      description: "Move a file or directory.",
      inputSchema: moveArgs,
      permissionLevel: "SAFE_WRITE",
      tags: ["fs"],
    },
    validate(args: unknown): asserts args is { from: string; to: string } {
      validated(moveArgs, args);
    },
    async execute(args) {
      await files.move(args.from, args.to);
      return { from: args.from, to: args.to, moved: true };
    },
  });

  const rename = defineTool({
    metadata: {
      name: "file.rename",
      description: "Rename a file or directory.",
      inputSchema: renameArgs,
      permissionLevel: "SAFE_WRITE",
      tags: ["fs"],
    },
    validate(args: unknown): asserts args is { from: string; to: string } {
      validated(renameArgs, args);
    },
    async execute(args) {
      await files.rename(args.from, args.to);
      return { from: args.from, to: args.to, renamed: true };
    },
  });

  const exists = defineTool({
    metadata: {
      name: "file.exists",
      description: "Check whether a path exists.",
      inputSchema: existsArgs,
      permissionLevel: "READ_ONLY",
      tags: ["fs"],
    },
    validate(args: unknown): asserts args is { path: string } {
      validated(existsArgs, args);
    },
    async execute(args) {
      return { path: args.path, exists: await files.exists(args.path) };
    },
  });

  const list = defineTool({
    metadata: {
      name: "file.list",
      description: "List a directory's entries (optionally recursive).",
      inputSchema: listArgs,
      permissionLevel: "READ_ONLY",
      tags: ["fs"],
    },
    validate(args: unknown): asserts args is { path: string; recursive?: boolean; maxEntries?: number } {
      validated(listArgs, args);
    },
    async execute(args) {
      const entries: DirectoryEntry[] = await files.list(args.path, {
        recursive: args.recursive,
        maxEntries: args.maxEntries,
      });
      return { path: args.path, count: entries.length, entries };
    },
  });

  const search = defineTool({
    metadata: {
      name: "file.search",
      description: "Search file names and contents under a root directory.",
      inputSchema: searchArgs,
      permissionLevel: "READ_ONLY",
      tags: ["fs"],
    },
    validate(args: unknown): asserts args is { root: string; query: string; maxResults?: number } {
      validated(searchArgs, args);
    },
    async execute(args) {
      const matches = await files.search(args.root, args.query, { maxResults: args.maxResults });
      return { root: args.root, query: args.query, count: matches.length, matches };
    },
  });

  const metadata = defineTool({
    metadata: {
      name: "file.metadata",
      description: "Get file metadata (size, timestamps, kind).",
      inputSchema: metadataArgs,
      permissionLevel: "READ_ONLY",
      tags: ["fs"],
    },
    validate(args: unknown): asserts args is { path: string } {
      validated(metadataArgs, args);
    },
    async execute(args) {
      return files.metadata(args.path);
    },
  });

  return [read, write, create, del, copy, move, rename, exists, list, search, metadata];
}
