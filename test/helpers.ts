import { MemoryCache } from '../src/cache.js';
import type { Ctx } from '../src/context.js';
import type { EngineDeps } from '../src/engine.js';
import { HttpClient } from '../src/http.js';
import { HostLimiter } from '../src/limiter.js';
import type { DnsResolver } from '../src/signals/dns.js';
import type { TlsProber } from '../src/signals/tls.js';

export const NOW = new Date('2026-10-04T00:00:00Z');
export const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

export type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | 'network-error' | 'timeout' | 'refused';

export interface MockFetch {
  (url: string, init?: RequestInit): Promise<Response>;
  calls: string[];
  headers: Array<Record<string, string>>;
}

/** Router: first matching prefix wins; unmatched URLs throw so tests notice. */
export function mockFetch(routes: Array<[string | RegExp, Route]>): MockFetch {
  const f = (async (url: string, init?: RequestInit) => {
    f.calls.push(url);
    f.headers.push((init?.headers ?? {}) as Record<string, string>);
    const hit = routes.find(([k]) => (typeof k === 'string' ? url.startsWith(k) : k.test(url)));
    if (!hit) throw new Error(`unmocked URL ${url}`);
    const r = await hit[1](url, init);
    if (r === 'network-error') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } });
    if (r === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } });
    if (r === 'timeout') {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    return r;
  }) as MockFetch;
  f.calls = [];
  f.headers = [];
  return f;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

export const redirect = (location: string, status = 301) => new Response(null, { status, headers: { location } });

export const okDns: DnsResolver = async () => ({ ok: true, addresses: ['93.184.216.34'] });
export const okTls: TlsProber = async () => ({
  ok: true,
  validFrom: daysAgo(30),
  validTo: new Date(NOW.getTime() + 60 * 86_400_000).toISOString(),
  issuer: 'Test CA',
  authorized: true,
});

export function client(fetch: MockFetch, cache = true): HttpClient {
  return new HttpClient({
    fetch,
    cache: cache ? new MemoryCache() : undefined,
    limiter: new HostLimiter(() => ({ maxConcurrent: 100, minGapMs: 0 }), async () => {}),
  });
}

export function ctx(fetch: MockFetch, over: Partial<Ctx> = {}): Ctx {
  return { http: client(fetch), dns: okDns, tls: okTls, now: () => NOW, fresh: false, options: {}, ...over };
}

export function deps(fetch: MockFetch, over: Partial<EngineDeps> = {}): EngineDeps {
  return { http: client(fetch), dns: okDns, tls: okTls, now: () => NOW, sleep: async () => {}, backoffMs: [0, 0, 0], ...over };
}

export const LONG_TEXT = 'Lorem ipsum dolor sit amet consectetur. '.repeat(30);
