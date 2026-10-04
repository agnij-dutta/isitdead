/**
 * The core promise: an error is never counted as an absence. These tests pin
 * the paths where a failure could otherwise leak into a "dead" signal.
 */
import { describe, expect, it } from 'vitest';
import type { Probe } from '../src/context.js';
import { check } from '../src/engine.js';
import { HttpClient } from '../src/http.js';
import { HostLimiter } from '../src/limiter.js';
import { githubProbe } from '../src/signals/github.js';
import { jobsProbe } from '../src/signals/jobs.js';
import { waybackProbe } from '../src/signals/wayback.js';
import { webProbe } from '../src/signals/web.js';
import { xProbe } from '../src/signals/x.js';
import { buildTarget } from '../src/target.js';
import { decide } from '../src/verdict.js';
import { ctx, deps, html, json, LONG_TEXT, mockFetch } from './helpers.js';

const GHB = 'https://boards-api.greenhouse.io/';
const ASH = 'https://api.ashbyhq.com/';
const LEV = 'https://api.lever.co/';

describe('web: refused vs error on the http fallback', () => {
  it('https refused but http timed out is an error, not "refuses connections"', async () => {
    const f = mockFetch([
      ['https://half.test/', () => 'refused'],
      ['http://half.test/', () => 'timeout'],
    ]);
    const rs = await webProbe.run(buildTarget('half.test'), ctx(f));
    const http = rs.find((r) => r.signal === 'http')!;
    expect(http.state).toBe('unknown');
    expect(http.unknownReason).toBe('error');
  });

  it('https reset and http refused keeps the https error', async () => {
    const f = mockFetch([
      ['https://reset.test/', () => 'network-error'],
      ['http://reset.test/', () => 'refused'],
    ]);
    const rs = await webProbe.run(buildTarget('reset.test'), ctx(f));
    expect(rs.find((r) => r.signal === 'http')!.unknownReason).toBe('error');
  });
});

describe('jobs: an error elsewhere blocks the empty-board negative', () => {
  it('empty Greenhouse board while Lever errored is unknown(error), not stale', async () => {
    const f = mockFetch([
      [GHB, () => json({ jobs: [] })],
      [ASH, () => json({}, 404)],
      [LEV, () => json({}, 503)],
    ]);
    const [r] = await jobsProbe.run(buildTarget('acme.test'), ctx(f));
    expect(r!.state).toBe('unknown');
    expect(r!.unknownReason).toBe('error');
  });

  it('a body truncated at the size cap counts postings as a lower bound', async () => {
    const posting = (i: number) => `{"id":"${i}","title":"Role ${i}","isListed":true,"descriptionHtml":"${'x'.repeat(200)}"}`;
    const body = `{"jobs":[${Array.from({ length: 50 }, (_, i) => posting(i)).join(',')}]}`;
    const f = mockFetch([
      [GHB, () => json({}, 404)],
      [ASH, () => new Response(body, { headers: { 'content-type': 'application/json' } })],
      [LEV, () => json({}, 404)],
    ]);
    const http = new HttpClient({ fetch: f, maxBodyBytes: 3000, limiter: new HostLimiter(() => ({ maxConcurrent: 9, minGapMs: 0 })) });
    const [r] = await jobsProbe.run(buildTarget('acme.test'), ctx(f, { http }));
    expect(r!.state).toBe('alive');
    expect(r!.summary).toMatch(/\d+\+ open role/);
  });

  it('a truncated body with no posting marker is an error, not zero roles', async () => {
    const f = mockFetch([
      [GHB, () => json({}, 404)],
      [ASH, () => new Response(`{"jobs":[{"descriptionHtml":"${'x'.repeat(5000)}"}]}`)],
      [LEV, () => json({}, 404)],
    ]);
    const http = new HttpClient({ fetch: f, maxBodyBytes: 1000, limiter: new HostLimiter(() => ({ maxConcurrent: 9, minGapMs: 0 })) });
    const [r] = await jobsProbe.run(buildTarget('acme.test'), ctx(f, { http }));
    expect(r!.unknownReason).toBe('error');
  });
});

describe('unreadable 200 bodies are errors', () => {
  it('github 200 with a non-JSON body', async () => {
    const f = mockFetch([['https://api.github.com/', () => html('<html>oops</html>')]]);
    const [r] = await githubProbe.run(buildTarget('github:acme'), ctx(f));
    expect(r!.unknownReason).toBe('error');
  });

  it('wayback 200 with a non-JSON body', async () => {
    const f = mockFetch([['https://web.archive.org/', () => html('<html>busy</html>')]]);
    const [r] = await waybackProbe.run(buildTarget('acme.test'), ctx(f, { options: { wayback: true } }));
    expect(r!.unknownReason).toBe('error');
  });

  it('fxtwitter 200 with no user object', async () => {
    const f = mockFetch([['https://api.fxtwitter.com/', () => json({ code: 200 })]]);
    const [r] = await xProbe.run(buildTarget('@example_co'), ctx(f));
    expect(r!.unknownReason).toBe('error');
  });
});

describe('engine', () => {
  it('a crashing multi-signal probe reports an error under each of its signals', async () => {
    const boom: Probe = {
      id: 'web',
      signals: ['http', 'hosting', 'content'],
      applies: () => true,
      run: async () => {
        throw new Error('kaboom');
      },
    };
    const r = await check(buildTarget('acme.test'), deps(mockFetch([]), { probes: [boom] }));
    expect(r.report.signals.map((s) => s.signal).sort()).toEqual(['content', 'hosting', 'http']);
    expect(r.report.signals.every((s) => s.unknownReason === 'error')).toBe(true);
    expect(r.report.verdict.verdict).toBe('UNKNOWN');
  });

  it('when a failed homepage fetch recovers, hosting and content are filled in too', async () => {
    let n = 0;
    const f = mockFetch([['https://acme.test/', () => (n++ === 0 ? 'timeout' : html(`<title>Acme</title><p>Acme ${LONG_TEXT}</p>`))]]);
    const r = await check(buildTarget('acme.test'), deps(f, { probes: [webProbe] }));
    const by = (name: string) => r.report.signals.find((s) => s.signal === name)!;
    expect(by('http').confirmation?.outcome).toBe('recovered');
    expect(by('content').state).toBe('alive');
    expect(by('content').confirmation?.outcome).toBe('refreshed');
    expect(by('hosting').state).toBe('alive');
  });

  it('errors alone, however many, never produce DEAD or DORMANT', () => {
    const err = {
      signal: 'http' as const,
      state: 'unknown' as const,
      unknownReason: 'error' as const,
      summary: '',
      evidence: {},
      checkedAt: '',
    };
    const v = decide(Array.from({ length: 20 }, () => ({ ...err, weight: 1 })));
    expect(v.verdict).toBe('UNKNOWN');
  });
});
