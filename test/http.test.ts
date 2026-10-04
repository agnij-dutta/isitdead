import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyApi, HttpClient, USER_AGENT, VERSION, type HttpResult } from '../src/http.js';
import { client, html, json, mockFetch, redirect } from './helpers.js';

describe('HttpClient', () => {
  it('sends a user-agent identifying the tool', async () => {
    const f = mockFetch([['https://a.test/', () => html('ok')]]);
    await client(f).get('https://a.test/');
    expect(f.headers[0]!['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^isitdead\//);
  });

  it('records the full redirect chain when following', async () => {
    const f = mockFetch([
      ['https://a.test/', () => redirect('https://www.a.test/')],
      ['https://www.a.test/en', () => html('<title>A</title>')],
      ['https://www.a.test/', () => redirect('/en', 302)],
    ]);
    const r = await client(f).get('https://a.test/', { follow: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe('https://www.a.test/en');
    expect(r.chain.map((h) => h.status)).toEqual([301, 302, 200]);
  });

  it('does not follow redirects for API calls by default', async () => {
    const f = mockFetch([['https://api.test/', () => redirect('https://github.com/FxEmbed/FxEmbed', 302)]]);
    const r = await client(f).get('https://api.test/');
    expect(r.ok && r.status).toBe(302);
  });

  it('turns timeouts and resets into errors, not statuses', async () => {
    const f = mockFetch([
      ['https://slow.test/', () => 'timeout'],
      ['https://reset.test/', () => 'network-error'],
    ]);
    const a = await client(f).get('https://slow.test/');
    const b = await client(f).get('https://reset.test/');
    expect(a.ok).toBe(false);
    expect(!a.ok && a.code).toBe('ETIMEDOUT');
    expect(!b.ok && b.code).toBe('ECONNRESET');
  });

  it('caches clean answers, never errors, and fresh mode bypasses cache reads', async () => {
    let n = 0;
    const f = mockFetch([
      ['https://c.test/ok', () => json({ n: ++n })],
      ['https://c.test/429', () => json({}, 429)],
    ]);
    const c = client(f);
    await c.get('https://c.test/ok');
    const hit = await c.get('https://c.test/ok');
    expect(hit.ok && hit.fromCache).toBe(true);
    const fresh = await c.get('https://c.test/ok', { fresh: true });
    expect(fresh.ok && fresh.fromCache).toBe(false);
    await c.get('https://c.test/429');
    await c.get('https://c.test/429');
    expect(f.calls.filter((u) => u.endsWith('429')).length).toBe(2);
  });
});

describe('classifyApi: error is not absence', () => {
  const r = (status: number, headers: Record<string, string> = {}): HttpResult => ({
    ok: true,
    status,
    headers,
    body: '',
    truncated: false,
    url: 'u',
    chain: [],
    fromCache: false,
  });

  it('only 404 and 410 are absence', () => {
    expect(classifyApi(r(404)).kind).toBe('absent');
    expect(classifyApi(r(410)).kind).toBe('absent');
    expect(classifyApi(r(200)).kind).toBe('found');
  });

  it.each([429, 500, 502, 503, 401, 400, 302])('status %i is an error', (s) => {
    expect(classifyApi(r(s, { location: 'x' })).kind).toBe('error');
  });

  it('GitHub quota exhaustion (403 + remaining 0) is an error', () => {
    const o = classifyApi(r(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791097880' }));
    expect(o.kind).toBe('error');
    expect(o.kind === 'error' && o.reason).toMatch(/rate limited/);
  });

  it('network failure is an error', () => {
    expect(classifyApi({ ok: false, error: 'boom', code: 'ECONNRESET', url: 'u', chain: [] }).kind).toBe('error');
  });

  it('carries Retry-After', () => {
    const o = classifyApi(r(429, { 'retry-after': '7' }));
    expect(o.kind === 'error' && o.retryAfterSec).toBe(7);
  });
});

describe('package metadata', () => {
  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe('body size cap', () => {
  it('flags a truncated body instead of silently returning a partial one', async () => {
    const big = 'x'.repeat(5000);
    const f = mockFetch([['https://big.test/', () => html(big)]]);
    const c = new HttpClient({ fetch: f, maxBodyBytes: 1000 });
    const r = await c.get('https://big.test/');
    expect(r.ok && r.truncated).toBe(true);
    const small = await new HttpClient({ fetch: mockFetch([['https://s.test/', () => html('ok')]]) }).get('https://s.test/');
    expect(small.ok && small.truncated).toBe(false);
  });
});
