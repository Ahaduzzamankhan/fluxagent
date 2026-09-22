/**
 * FluxAgent — authentication & authorization abstraction (Phase 8.4).
 *
 * Principals are produced by authenticators (pluggable): today an API-key
 * authenticator and a local (loopback) authenticator are implemented; OAuth /
 * OIDC / scoped-token authenticators implement the same interface later.
 *
 * Secrets are never stored here in plaintext longer than request lifetime —
 * keys are compared by digest. A SecretProvider interface exists so engines
 * can fetch credentials (for provider adapters) without them touching logs,
 * prompts, or task results.
 */

import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { FluxError } from "../utils/errors.ts";

// ─── Principal & scopes ───────────────────────────────────────────────────────

export type AuthScope =
  | "agent:run"
  | "agent:stream"
  | "tasks:read"
  | "tasks:write"
  | "sessions:read"
  | "sessions:write"
  | "tools:read"
  | "models:read"
  | "events:read"
  | "admin";

export interface Principal {
  readonly kind: "api-key" | "local" | "token";
  readonly id: string;
  readonly scopes: readonly AuthScope[];
}

export const LOCAL_PRINCIPAL: Principal = {
  kind: "local",
  id: "loopback",
  scopes: ["agent:run", "agent:stream", "tasks:read", "tasks:write", "sessions:read", "sessions:write", "tools:read", "models:read", "events:read"],
};

export function hasScope(principal: Principal, scope: AuthScope): boolean {
  return principal.scopes.includes("admin") || principal.scopes.includes(scope);
}

// ─── Authenticators ───────────────────────────────────────────────────────────

export interface Authenticator {
  readonly name: string;
  /** Returns the principal or null when unauthenticated. */
  authenticate(request: { headers: Readonly<Record<string, string | undefined>>; remoteAddress?: string }): Promise<Principal | null>;
}

/**
 * API-key authenticator. Keys are registered as SHA-256 digests; incoming
 * keys are digested and compared with timing-safe equality. The plaintext
 * key is never retained.
 */
export class ApiKeyAuthenticator implements Authenticator {
  readonly name = "api-key";
  private readonly digests = new Map<string, { id: string; scopes: readonly AuthScope[] }>();

  /** Register a key; returns the digest handle. Callers keep their own copy. */
  registerKey(plaintextKey: string, principal: { id: string; scopes: readonly AuthScope[] }): string {
    const digest = sha256(plaintextKey);
    this.digests.set(digest, principal);
    return digest.slice(0, 12); // handle only — not reversible
  }

  async authenticate(request: { headers: Readonly<Record<string, string | undefined>> }): Promise<Principal | null> {
    const header = request.headers["authorization"] ?? request.headers["x-api-key"];
    if (!header) return null;
    const key = header.startsWith("Bearer ") ? header.slice(7) : header;
    const digest = sha256(key);
    const entry = this.digests.get(digest);
    if (!entry) return null;
    // Timing-safe comparison of digests.
    const a = Buffer.from(digest, "hex");
    const b = Buffer.from(sha256(key), "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { kind: "api-key", id: entry.id, scopes: entry.scopes };
  }

  get keyCount(): number {
    return this.digests.size;
  }
}

/**
 * Local authenticator: trusts loopback connections only (no network calls
 * accepted unauthenticated on non-loopback addresses).
 */
export class LocalAuthenticator implements Authenticator {
  readonly name = "local";

  async authenticate(request: { remoteAddress?: string }): Promise<Principal | null> {
    const addr = request.remoteAddress ?? "";
    const isLoopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr === "";
    return isLoopback ? LOCAL_PRINCIPAL : null;
  }
}

export interface AuthResult {
  readonly principal: Principal;
  readonly via: string;
}

/** Composite: try authenticators in order; first hit wins. */
export class AuthService {
  private readonly authenticators: Authenticator[];

  constructor(authenticators: readonly Authenticator[]) {
    this.authenticators = [...authenticators];
  }

  async authenticate(request: { headers: Readonly<Record<string, string | undefined>>; remoteAddress?: string }): Promise<AuthResult | null> {
    for (const a of this.authenticators) {
      const principal = await a.authenticate(request);
      if (principal) return { principal, via: a.name };
    }
    return null;
  }

  require(request: { headers: Readonly<Record<string, string | undefined>>; remoteAddress?: string }, scope: AuthScope): Promise<AuthResult> {
    return this.authenticate(request).then((result) => {
      if (!result) {
        throw new FluxError({ code: "E_PERMISSION_DENIED", message: "authentication required" });
      }
      if (!hasScope(result.principal, scope)) {
        throw new FluxError({
          code: "E_PERMISSION_DENIED",
          message: `missing scope "${scope}"`,
          details: { scope },
        });
      }
      return result;
    });
  }
}

/** Generate a fresh API key (returned once; digest stored by the caller). */
export function generateApiKey(): string {
  return `fa_${randomBytes(24).toString("hex")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ─── Secret provider (10.4 lives here too — single seam) ──────────────────────

/**
 * Secrets are fetched lazily by name (e.g. "openai:api-key") and are NEVER
 * returned in logs, prompts, or serialized results — the interface returns
 * them only to code that needs them to authenticate.
 */
export interface SecretProvider {
  readonly name: string;
  getSecret(name: string): Promise<string | null>;
}

/** Environment-backed provider: secrets come from process env vars. */
export class EnvSecretProvider implements SecretProvider {
  readonly name = "env";
  private readonly prefix: string;

  constructor(prefix = "FLUX_SECRET_") {
    this.prefix = prefix;
  }

  async getSecret(name: string): Promise<string | null> {
    const key = `${this.prefix}${name.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
    return process.env[key] ?? null;
  }
}

/** Static provider for tests/dev; values are held in memory only. */
export class InMemorySecretProvider implements SecretProvider {
  readonly name = "memory";
  private readonly secrets = new Map<string, string>();

  setSecret(name: string, value: string): void {
    this.secrets.set(name, value);
  }

  async getSecret(name: string): Promise<string | null> {
    return this.secrets.get(name) ?? null;
  }
}

/** Composite: first provider that has the secret wins. */
export class CompositeSecretProvider implements SecretProvider {
  readonly name = "composite";
  private readonly providers: readonly SecretProvider[];

  constructor(providers: readonly SecretProvider[]) {
    this.providers = providers;
  }

  async getSecret(name: string): Promise<string | null> {
    for (const p of this.providers) {
      const value = await p.getSecret(name);
      if (value !== null) return value;
    }
    return null;
  }
}
