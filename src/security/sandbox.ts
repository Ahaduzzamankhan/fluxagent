/**
 * FluxAgent — sandbox: filesystem boundary + command policy.
 *
 * Pure, testable guards (no I/O). Controllers call these before touching the
 * OS. Cross-platform: platform-specific defaults come from the platform layer
 * (src/platform/platform.ts) — Windows drive rules, POSIX filesystem rules.
 */

import { SandboxViolationError, CommandBlockedError, FluxError } from "../utils/errors.ts";
import { canonicalPathFor, platformFacts, isWindowsPath as detectWindowsPath } from "../platform/platform.ts";

export interface SandboxPolicy {
  /** Empty means "no explicit allowlist" (all roots allowed except denied). */
  readonly allowedRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  /** Substrings that block a command outright (case-insensitive). */
  readonly blockedCommandTokens: readonly string[];
}

/** Platform-appropriate policy defaults (deny OS-critical dirs/commands). */
export function defaultSandboxPolicy(platform: NodeJS.Platform = process.platform): SandboxPolicy {
  const facts = platformFacts(platform);
  return { allowedRoots: [], deniedRoots: facts.defaults.deniedRoots, blockedCommandTokens: [...facts.defaults.blockedCommandTokens] };
}

/**
 * Defaults for the CURRENT host. Pure policy data — controllers still need
 * explicit approval paths for anything destructive.
 */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = defaultSandboxPolicy();

export function isWindowsPath(p: string): boolean {
  return detectWindowsPath(p);
}

/**
 * Canonicalize a path for comparison on the CURRENT host (see
 * `canonicalPathFor` for explicit-platform use). Kept as a stable export.
 */
export function canonicalPath(p: string): string {
  return canonicalPathFor(p, process.platform);
}

/** True when `target` is inside (or equal to) `root`. */
export function isInsideRoot(target: string, root: string): boolean {
  const t = canonicalPath(target);
  const r = canonicalPath(root);
  return t.startsWith(r);
}

export function checkPathAllowed(target: string, policy: SandboxPolicy): void {
  const violations: string[] = [];
  for (const denied of policy.deniedRoots) {
    if (isInsideRoot(target, denied)) violations.push(`path inside denied root: ${denied}`);
  }
  if (policy.allowedRoots.length > 0) {
    const inAllowed = policy.allowedRoots.some((root) => isInsideRoot(target, root));
    if (!inAllowed) violations.push("path outside allowed roots");
  }
  if (violations.length > 0) {
    throw new SandboxViolationError(`Path not allowed: ${target}`, { target, violations });
  }
}

export interface CommandPolicyResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** Inspect a command + args against the blocklist. Pure. */
export function checkCommandAllowed(
  command: string,
  args: readonly string[],
  policy: SandboxPolicy,
): CommandPolicyResult {
  const full = `${command} ${args.join(" ")}`.toLowerCase();
  for (const token of policy.blockedCommandTokens) {
    if (full.includes(token.toLowerCase())) {
      return { allowed: false, reason: `matches blocked token "${token.trim()}"` };
    }
  }
  return { allowed: true };
}

/** Enforce + throw variants used by controllers. */
export function enforcePathAllowed(target: string, policy: SandboxPolicy): void {
  checkPathAllowed(target, policy);
}

export function enforceCommandAllowed(command: string, args: readonly string[], policy: SandboxPolicy): void {
  const result = checkCommandAllowed(command, args, policy);
  if (!result.allowed) {
    throw new CommandBlockedError(command, args, result.reason ?? "policy");
  }
}

// Re-exports so callers don't need errors.ts for common guards.
export { SandboxViolationError, CommandBlockedError, FluxError, canonicalPathFor };
