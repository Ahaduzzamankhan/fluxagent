/**
 * FluxAgent — permission levels.
 *
 * Ordered: READ_ONLY < SAFE_WRITE < USER_CONFIRMATION < PRIVILEGED.
 * Tools declare their level; the PermissionManager enforces the session's
 * ceiling and the approval flow.
 */

export const PERMISSION_LEVELS = ["READ_ONLY", "SAFE_WRITE", "USER_CONFIRMATION", "PRIVILEGED"] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export function permissionRank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

export function permissionAtLeast(level: PermissionLevel, minimum: PermissionLevel): boolean {
  return permissionRank(level) >= permissionRank(minimum);
}

export function isPermissionLevel(v: unknown): v is PermissionLevel {
  return typeof v === "string" && (PERMISSION_LEVELS as readonly string[]).includes(v);
}
