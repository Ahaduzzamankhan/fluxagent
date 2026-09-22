#!/usr/bin/env node
/**
 * FluxAgent CLI launcher.
 *
 * The runtime is TypeScript-run-directly (Node >= 22.6
 * `--experimental-strip-types`, zero dependencies), so this bin shim enables
 * type-stripping for the import and delegates to the CLI module. No build
 * step required.
 */
process.env["NODE_OPTIONS"] = `${process.env["NODE_OPTIONS"] ?? ""} --experimental-strip-types`.trim();
await import(new URL("../src/cli/index.ts", import.meta.url).href);
