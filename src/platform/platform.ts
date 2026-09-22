/**
 * FluxAgent — platform adapter layer.
 *
 * The core brain is platform-independent. Everything that genuinely differs
 * between Windows / Linux / macOS is expressed here as data + tiny adapters:
 *
 *   - default sandbox roots (deny OS-critical directories per platform)
 *   - default blocked command tokens (destructive commands per platform)
 *   - path canonicalization for sandbox comparisons
 *   - shell / temp-dir facts used by controllers and the doctor
 *
 * Controllers stay thin: they consult `PlatformFacts` instead of hard-coding
 * `C:\…` or PowerShell. Pure functions only — no I/O here.
 */

export type SupportedPlatform = "windows" | "linux" | "macos";

export function normalizePlatform(platform: NodeJS.Platform | SupportedPlatform): SupportedPlatform {
  // Accept already-normalized values (platform selection is centralized here —
  // callers pass either a Node host string like "win32" or a logical key).
  if (platform === "windows" || platform === "macos" || platform === "linux") return platform;
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
    case "freebsd":
    case "openbsd":
      return "linux";
    default:
      return "linux"; // POSIX-fallback; specifics degrade gracefully elsewhere.
  }
}

export interface SandboxDefaults {
  readonly deniedRoots: readonly string[];
  readonly blockedCommandTokens: readonly string[];
}

const WINDOWS_DEFAULTS: SandboxDefaults = {
  deniedRoots: ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)"],
  blockedCommandTokens: [
    "rm -rf", "format ", "cipher /w", "vssadmin delete", "bcdedit",
    "del /f /s /q c:\\", "rd /s /q c:\\",
  ],
};

const LINUX_DEFAULTS: SandboxDefaults = {
  deniedRoots: ["/boot", "/etc", "/proc", "/sys", "/usr", "/var/log"],
  blockedCommandTokens: [
    "rm -rf /", "rm -fr /", "mkfs", "dd if=/dev/zero", "dd if=/dev/urandom of=/dev/",
    "shutdown -h", "reboot", ":(){ :|:& };:", "chmod -r 777 /", "chown -r 0:0 /",
  ],
};

const MACOS_DEFAULTS: SandboxDefaults = {
  deniedRoots: ["/System", "/Library", "/etc", "/usr", "/private/var/log"],
  blockedCommandTokens: [
    "rm -rf /", "rm -fr /", "diskutil erase", "shutdown -h", "reboot",
    "killall -9 loginwindow", "csrutil disable", ":(){ :|:& };:",
  ],
};

export function sandboxDefaults(platform: NodeJS.Platform | SupportedPlatform): SandboxDefaults {
  const key = typeof platform === "string" && (platform === "windows" || platform === "macos" || platform === "linux")
    ? platform
    : normalizePlatform(platform as NodeJS.Platform);
  switch (key) {
    case "windows":
      return WINDOWS_DEFAULTS;
    case "macos":
      return MACOS_DEFAULTS;
    default:
      return LINUX_DEFAULTS;
  }
}

export function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/**
 * Canonicalize a path for sandbox *comparison only* (not for I/O):
 * - Windows: backslashes, trailing separator, lowercased (case-insensitive FS).
 * - POSIX: forward slashes, trailing separator, case preserved (case-sensitive).
 */
export function canonicalPathFor(p: string, platform: NodeJS.Platform | SupportedPlatform): string {
  const isWindows = (typeof platform === "string" && platform === "windows") ||
    (platform !== "windows" && platform !== "macos" && platform !== "linux" && normalizePlatform(platform as NodeJS.Platform) === "windows");
  if (isWindows) {
    const norm = p.replace(/\//g, "\\").trim();
    return norm.endsWith("\\") ? norm.toLowerCase() : `${norm}\\`.toLowerCase();
  }
  const norm = p.replace(/\\/g, "/").trim();
  return norm.endsWith("/") && norm !== "/" ? norm.slice(0, -1) : norm;
}

export interface PlatformFacts {
  readonly key: SupportedPlatform;
  readonly isWindows: boolean;
  /** Shell used for interactive/`shell:` execution on this platform. */
  readonly shellName: string;
  /** Default temp directory (honors TMPDIR/TEMP/TMP). */
  readonly tempDir: string;
  readonly pathSeparator: string;
  readonly defaults: SandboxDefaults;
}

export function platformFacts(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): PlatformFacts {
  const key = normalizePlatform(platform);
  return {
    key,
    isWindows: key === "windows",
    shellName: key === "windows" ? (env["COMSPEC"] ?? "cmd.exe") : (env["SHELL"] ?? "/bin/sh"),
    tempDir: key === "windows" ? (env["TEMP"] ?? env["TMP"] ?? "C:\\Temp") : (env["TMPDIR"] ?? env["TMP"] ?? env["TEMP"] ?? "/tmp"),
    pathSeparator: key === "windows" ? "\\" : "/",
    defaults: sandboxDefaults(key),
  };
}
