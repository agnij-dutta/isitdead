import { describe, expect, it } from 'vitest';
import { batch, check } from '../src/engine.js';
import { flakyDemo } from '../src/demo.js';
import { xProbe } from '../src/signals/x.js';
import { githubProbe } from '../src/signals/github.js';
import { buildTarget } from '../src/target.js';
import { decide } from '../src/verdict.js';
import type { SignalResult } from '../src/types.js';
import { daysAgo, deps, json, mockFetch } from './helpers.js';

const FX = 'https://api.fxtwitter.com/2/profile/';
const liveUser = () => json({ code: 200, user: { screen_name: 'example_co', description: 'building', followers: 5 } });
const statuses = () => json({ code: 200, results: [{ created_timestamp: Math.floor(Date.parse(daysAgo(2)) / 1000) }] });
const notFound = () => json({ code: 404, message: 'User not found' }, 404);

describe('serial re-confirmation of negatives', () => {
  it('a transient false 404 flips to alive on re-check', async () => {
    let n = 0;
    const f = mockFetch([
      [/statuses$/, () => statuses()],
      [FX, () => (n++ === 0 ? notFound() : liveUser())],
    ]);
    const r = await check(buildTarget('@example_co'), deps(f, { probes: [xProbe] }));
    const p = r.report.signals.find((s) => s.signal === 'x-profile')!;
    expect(p.state).toBe('alive');
    expect(p.confirmation?.outcome).toBe('flipped-alive');
    expect(r.stats.flippedAlive).toBe(1);
    expect(r.discoveryVerdict.verdict).toBe('DEAD');
    expect(r.report.verdict.verdict).not.toBe('DEAD');
    // x-activity appears once the profile resolves
    expect(r.report.signals.some((s) => s.signal === 'x-activity')).toBe(true);
  });

  it('a real 404 is confirmed and stays dead', async () => {
    const f = mockFetch([[FX, () => notFound()]]);
    const r = await check(buildTarget('@gone_example'), deps(f, { probes: [xProbe] }));
    expect(r.report.signals[0]!.confirmation?.outcome).toBe('confirmed');
    expect(r.report.verdict.verdict).toBe('DEAD');
    expect(r.stats.confirmed).toBe(1);
  });

  it('re-confirmation bypasses the cache', async () => {
    const f = mockFetch([[FX, () => notFound()]]);
    await check(buildTarget('@gone_example'), deps(f, { probes: [xProbe] }));
    expect(f.calls.length).toBe(2);
  });

  it('a negative whose re-check keeps erroring is downgraded to UNKNOWN, never dead', async () => {
    let n = 0;
    const f = mockFetch([[FX, () => (n++ === 0 ? notFound() : json({}, 429))]]);
    const r = await check(buildTarget('@example_co'), deps(f, { probes: [xProbe] }));
    const p = r.report.signals[0]!;
    expect(p.state).toBe('unknown');
    expect(p.unknownReason).toBe('error');
    expect(p.confirmation?.outcome).toBe('unconfirmed');
    expect(r.report.verdict.verdict).toBe('UNKNOWN');
    expect(r.stats.unconfirmed).toBe(1);
  });

  it('retries with backoff and honours Retry-After, up to the configured attempts', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const f = mockFetch([
      [/statuses$/, () => statuses()],
      [FX, () => (n++ < 2 ? json({}, 429, { 'retry-after': '2' }) : liveUser())],
    ]);
    const r = await check(
      buildTarget('@example_co'),
      deps(f, { probes: [xProbe], backoffMs: [100, 200, 400], sleep: async (ms) => void sleeps.push(ms) }),
    );
    expect(sleeps).toEqual([100, 2000]);
    expect(r.report.signals[0]!.confirmation?.outcome).toBe('recovered');
  });

  it('an errored signal that never recovers stays unknown(error)', async () => {
    const f = mockFetch([[FX, () => json({}, 503)]]);
    const r = await check(buildTarget('@example_co'), deps(f, { probes: [xProbe] }));
    expect(r.report.signals[0]!.confirmation?.outcome).toBe('still-error');
    expect(r.stats.stillError).toBe(1);
    expect(f.calls.length).toBe(4);
  });

  it('--no-confirm reports the raw parallel pass', async () => {
    const f = mockFetch([[FX, () => notFound()]]);
    const r = await check(buildTarget('@gone_example'), deps(f, { probes: [xProbe] }), { noConfirm: true });
    expect(r.report.signals[0]!.confirmation).toBeUndefined();
    expect(f.calls.length).toBe(1);
  });

  it('a crashing probe is an error, not a negative', async () => {
    const boom = {
      id: 'github',
      signals: ['github'] as const,
      applies: () => true,
      run: async () => {
        throw new Error('kaboom');
      },
    };
    const f = mockFetch([]);
    const r = await check(buildTarget('github:x'), deps(f, { probes: [boom] }));
    expect(r.report.signals[0]!.state).toBe('unknown');
    expect(r.report.verdict.verdict).toBe('UNKNOWN');
  });
});

describe('batch', () => {
  it('reproduces the bio-sweep incident: 20 negatives, 15 flip on serial re-check', async () => {
    const b = await flakyDemo();
    expect(b.stats.negatives).toBe(20);
    expect(b.stats.flippedAlive).toBe(15);
    expect(b.stats.confirmed).toBe(5);
    expect(b.verdictsRescued).toBe(15);
    expect(b.results.filter((r) => r.report.verdict.verdict === 'DEAD')).toHaveLength(5);
  });

  it('runs discovery concurrently and confirmation one at a time', async () => {
    let inflight = 0;
    let maxDiscovery = 0;
    let maxConfirm = 0;
    let confirming = false;
    const f = mockFetch([
      [
        'https://api.github.com/',
        async () => {
          inflight++;
          if (confirming) maxConfirm = Math.max(maxConfirm, inflight);
          else maxDiscovery = Math.max(maxDiscovery, inflight);
          await new Promise((r) => setTimeout(r, 5));
          inflight--;
          return json({ message: 'Not Found' }, 404);
        },
      ],
    ]);
    const targets = Array.from({ length: 8 }, (_, i) => buildTarget(`github:org${i}`));
    const d = deps(f, { probes: [githubProbe] });
    const origSleep = d.sleep!;
    d.sleep = async (ms) => {
      confirming = true;
      return origSleep(ms);
    };
    const b = await batch(targets, d, { concurrency: 4 });
    expect(maxDiscovery).toBeGreaterThan(1);
    expect(maxConfirm).toBe(1);
    expect(b.stats.confirmed).toBe(8);
  });
});

describe('verdict', () => {
  const s = (state: SignalResult['state'], weight: number, extra: Partial<SignalResult> = {}): SignalResult => ({
    signal: 'http',
    state,
    weight,
    summary: 'x',
    evidence: {},
    checkedAt: '',
    ...(state === 'dead' ? { kind: 'gone' as const } : {}),
    ...extra,
  });

  it('errors alone are UNKNOWN', () => {
    const v = decide([s('unknown', 0, { unknownReason: 'error' }), s('unknown', 0, { unknownReason: 'error' })]);
    expect(v.verdict).toBe('UNKNOWN');
  });

  it('parked domain with a 200 is DEAD', () => {
    expect(decide([s('alive', 0.2), s('alive', 0.2), s('dead', 1.0), s('dead', 0.8)]).verdict).toBe('DEAD');
  });

  it('live website but stale forked GitHub is DORMANT', () => {
    expect(decide([s('alive', 0.2), s('alive', 0.3), s('alive', 0.2), s('dead', 0.9, { kind: 'stale' })]).verdict).toBe('DORMANT');
  });

  it('strong alive signals win', () => {
    const v = decide([s('alive', 1), s('alive', 1), s('alive', 0.3), s('dead', 0.3, { kind: 'stale' })]);
    expect(v.verdict).toBe('ALIVE');
    expect(v.confidence).toBeGreaterThan(0.6);
  });

  it('errors lower confidence', () => {
    const base = [s('alive', 1), s('alive', 0.7)];
    const a = decide(base).confidence;
    const b = decide([...base, s('unknown', 0, { unknownReason: 'error' }), s('unknown', 0, { unknownReason: 'error' })]).confidence;
    expect(b).toBeLessThan(a);
  });
});
