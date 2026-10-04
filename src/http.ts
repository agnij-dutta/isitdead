import type { Cache } from './cache.js';
import { HostLimiter } from './limiter.js';

export const VERSION = '0.1.0';
export const USER_AGENT = `isitdead/${VERSION} (liveness checker; polite, cached; +https://x.com/0xholmesdev)`;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface Hop {
  url: string;
  status: number;
  location?: string;
}

export type HttpResult =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: string;
      /** Final URL after redirects (or the request URL when not following). */
      url: string;
      chain: Hop[];
      fromCache: boolean;
    }
  | {
      ok: false;
      /** Low-level failure: DNS, refused, reset, TLS, timeout. Never an HTTP status. */
      error: string;
      code?: string;
      url: string;
      chain: Hop[];
    };

export interface RequestOptions {
  /** Follow redirects manually, recording each hop. Default false: a 3xx is returned as-is. */
  follow?: boolean;
  /** Skip reading from the cache (still writes). Used by serial re-confirmation. */
  fresh?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpClientOptions {
  fetch?: FetchLike;
  cache?: Cache;
  limiter?: HostLimiter;
  userAgent?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
}

/** Statuses that are worth caching: real answers, not transient failures. */
function cacheable(status: number) {
  return (status >= 200 && status < 300) || status === 404 || status === 410;
}

export class HttpClient {
  readonly fetchImpl: FetchLike;
  readonly cache?: Cache;
  readonly limiter: HostLimiter;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxRedirects: number;
  /** Count of network requests actually sent (cache hits excluded). */
  requests = 0;

  constructor(opts: HttpClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.cache = opts.cache;
    this.limiter = opts.limiter ?? new HostLimiter();
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxBodyBytes = opts.maxBodyBytes ?? 5_000_000;
    this.maxRedirects = opts.maxRedirects ?? 10;
  }

  async get(url: string, opts: RequestOptions = {}): Promise<HttpResult> {
    const chain: Hop[] = [];
    let current = url;
    for (let i = 0; i <= this.maxRedirects; i++) {
      const r = await this.once(current, opts);
      if (!r.ok) return { ...r, chain: [...chain, ...r.chain] };
      const location = r.headers['location'];
      const isRedirect = r.status >= 300 && r.status < 400 && location;
      if (!isRedirect || !opts.follow) {
        chain.push({ url: current, status: r.status });
        return { ...r, chain };
      }
      const next = new URL(location, current).toString();
      chain.push({ url: current, status: r.status, location: next });
      current = next;
    }
    return { ok: false, error: `too many redirects (>${this.maxRedirects})`, code: 'EREDIRECTS', url: current, chain };
  }

  private async once(url: string, opts: RequestOptions): Promise<HttpResult> {
    const key = `GET ${url} ${JSON.stringify(opts.headers ?? {})}`;
    if (this.cache && !opts.fresh) {
      const hit = await this.cache.get(key);
      if (hit) return { ok: true, status: hit.status, headers: hit.headers, body: hit.body, url, chain: [], fromCache: true };
    }
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return { ok: false, error: `invalid URL: ${url}`, code: 'EINVALIDURL', url, chain: [] };
    }
    return this.limiter.run(host, async () => {
      this.requests++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          signal: ctrl.signal,
          headers: { 'user-agent': this.userAgent, accept: '*/*', ...(opts.headers ?? {}) },
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        const body = await readCapped(res, this.maxBodyBytes);
        if (this.cache && cacheable(res.status)) {
          await this.cache.set(key, { status: res.status, headers, body, url, storedAt: Date.now() });
        }
        return { ok: true as const, status: res.status, headers, body, url, chain: [], fromCache: false };
      } catch (e) {
        const err = e as Error & { cause?: { code?: string; message?: string } };
        const aborted = err.name === 'AbortError' || ctrl.signal.aborted;
        const code = aborted ? 'ETIMEDOUT' : (err.cause?.code ?? (err as { code?: string }).code ?? 'EFETCH');
        const msg = aborted ? 'timed out' : (err.cause?.message ?? err.message);
        return { ok: false as const, error: msg, code, url, chain: [] };
      } finally {
        clearTimeout(timer);
      }
    });
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

/**
 * The single most important function in this tool.
 *
 * Maps an HTTP answer from a JSON API to "found" / "absent" / "error".
 * Only a clean 404 or 410 counts as absence. Rate limits, 5xx, auth walls,
 * unexpected redirects and network failures are errors, never absence.
 */
export type ApiOutcome =
  | { kind: 'found'; status: number }
  | { kind: 'absent'; status: number }
  | { kind: 'error'; reason: string; status?: number; retryAfterSec?: number };

export function classifyApi(r: HttpResult): ApiOutcome {
  if (!r.ok) return { kind: 'error', reason: `${r.code ?? 'error'}: ${r.error}` };
  const s = r.status;
  const retryAfter = parseRetryAfter(r.headers['retry-after']);
  if (s >= 200 && s < 300) return { kind: 'found', status: s };
  if (s === 404 || s === 410) return { kind: 'absent', status: s };
  if (s === 429) return { kind: 'error', reason: 'rate limited (429)', status: s, retryAfterSec: retryAfter };
  if (s === 403 && r.headers['x-ratelimit-remaining'] === '0') {
    const reset = Number(r.headers['x-ratelimit-reset']);
    const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : '';
    return { kind: 'error', reason: `rate limited (403, quota exhausted${when})`, status: s, retryAfterSec: retryAfter };
  }
  if (s >= 300 && s < 400) return { kind: 'error', reason: `unexpected redirect (${s}) to ${r.headers['location'] ?? '?'}`, status: s };
  if (s >= 500) return { kind: 'error', reason: `server error (${s})`, status: s, retryAfterSec: retryAfter };
  return { kind: 'error', reason: `unexpected status ${s}`, status: s, retryAfterSec: retryAfter };
}

function parseRetryAfter(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, Math.round((d - Date.now()) / 1000)) : undefined;
}

export function safeJson<T = unknown>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}
