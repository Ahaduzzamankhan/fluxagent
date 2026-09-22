/**
 * FluxAgent — network controller.
 *
 * Thin typed wrapper over Node's global fetch (Node 18+ built-in) with
 * timeout + size caps. No third-party HTTP libraries.
 */

export interface NetworkRequestSpec {
  readonly url: string;
  readonly method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  /** Abort if the body exceeds this size (default 5 MB). */
  readonly maxBodyBytes?: number;
}

export interface NetworkResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly durationMs: number;
}

export class NetworkController {
  async request(spec: NetworkRequestSpec): Promise<NetworkResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`timeout after ${spec.timeoutMs ?? 30_000}ms`)),
      spec.timeoutMs ?? 30_000,
    );
    try {
      const res = await fetch(spec.url, {
        method: spec.method ?? "GET",
        headers: spec.headers as Record<string, string> | undefined,
        body: spec.body,
        signal: controller.signal,
      });
      const max = spec.maxBodyBytes ?? 5 * 1024 * 1024;
      const buf = await res.arrayBuffer();
      const slice = buf.byteLength > max ? buf.slice(0, max) : buf;
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return {
        status: res.status,
        ok: res.ok,
        headers,
        body: Buffer.from(slice).toString("utf8"),
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async ping(url: string, timeoutMs = 5000): Promise<boolean> {
    try {
      const res = await this.request({ url, method: "HEAD", timeoutMs });
      return res.ok;
    } catch {
      return false;
    }
  }
}
