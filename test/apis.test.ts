import { describe, expect, it } from 'vitest';
import { githubProbe } from '../src/signals/github.js';
import { jobsProbe, slugCandidates } from '../src/signals/jobs.js';
import { npmProbe } from '../src/signals/npm.js';
import { waybackProbe } from '../src/signals/wayback.js';
import { bioStaleness, xProbe } from '../src/signals/x.js';
import { buildTarget } from '../src/target.js';
import { ctx, daysAgo, json, mockFetch, redirect } from './helpers.js';

const GH = 'https://api.github.com/users/';
const repo = (name: string, pushedDaysAgo: number, extra: Record<string, unknown> = {}) => ({
  name,
  full_name: `org/${name}`,
  fork: false,
  archived: false,
  pushed_at: daysAgo(pushedDaysAgo),
  ...extra,
});

describe('github', () => {
  const t = buildTarget('github:org');
  it('recent push to an original repo is alive', async () => {
    const f = mockFetch([[GH, () => json([repo('core', 3), repo('old', 900)])]]);
    const [r] = await githubProbe.run(t, ctx(f));
    expect(r!.state).toBe('alive');
    expect(f.calls[0]).toContain('sort=pushed');
  });

  it('the $10M "novel VM": two Uniswap v3 forks, last pushed 14 months ago', async () => {
    const f = mockFetch([[GH, () => json([repo('v3-core', 425, { fork: true }), repo('v3-periphery', 430, { fork: true })])]]);
    const [r] = await githubProbe.run(t, ctx(f));
    expect(r!.state).toBe('dead');
    expect(r!.kind).toBe('stale');
    expect(r!.summary).toMatch(/fork/);
    expect(r!.summary).toMatch(/v3-core/);
  });

  it('forks do not count as activity even if recently pushed', async () => {
    const f = mockFetch([[GH, () => json([repo('fork', 1, { fork: true }), repo('mine', 500)])]]);
    const [r] = await githubProbe.run(t, ctx(f));
    expect(r!.state).toBe('dead');
    expect(r!.summary).toMatch(/mine/);
  });

  it('all archived is gone', async () => {
    const f = mockFetch([[GH, () => json([repo('a', 800, { archived: true }), repo('b', 900, { archived: true })])]]);
    const [r] = await githubProbe.run(t, ctx(f));
    expect(r!.kind).toBe('gone');
    expect(r!.summary).toMatch(/archived/);
  });

  it('clean 404 is dead', async () => {
    const f = mockFetch([[GH, () => json({ message: 'Not Found' }, 404)]]);
    const [r] = await githubProbe.run(t, ctx(f));
    expect(r!.state).toBe('dead');
  });

  it('rate limit (403, remaining 0) is UNKNOWN, never dead', async () => {
    const f = mockFetch([
      [GH, () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791097880' })],
    ]);
    const [r] = await githubProbe.run(t, ctx(f));
    expect(r!.state).toBe('unknown');
    expect(r!.unknownReason).toBe('error');
    expect(r!.summary).toMatch(/rate limited/);
  });

  it('5xx is UNKNOWN', async () => {
    const f = mockFetch([[GH, () => json({}, 502)]]);
    const [r] = await githubProbe.run(t, ctx(f));
    expect(r!.state).toBe('unknown');
  });
});

describe('npm', () => {
  const t = buildTarget('npm:left-pad');
  const doc = (deprecated?: string, modified = daysAgo(10)) => ({
    name: 'left-pad',
    modified,
    'dist-tags': { latest: '1.3.0' },
    versions: { '1.3.0': { deprecated } },
  });
  it('deprecated latest is gone', async () => {
    const f = mockFetch([['https://registry.npmjs.org/', () => json(doc('use String.prototype.padStart()'))]]);
    const [r] = await npmProbe.run(t, ctx(f));
    expect(r!.kind).toBe('gone');
    expect(r!.summary).toMatch(/padStart/);
  });
  it('recently modified is alive', async () => {
    const f = mockFetch([['https://registry.npmjs.org/', () => json(doc())]]);
    expect((await npmProbe.run(t, ctx(f)))[0]!.state).toBe('alive');
  });
  it('years untouched is stale', async () => {
    const f = mockFetch([['https://registry.npmjs.org/', () => json(doc(undefined, daysAgo(1500)))]]);
    expect((await npmProbe.run(t, ctx(f)))[0]!.kind).toBe('stale');
  });
  it('404 is dead, 429 is unknown', async () => {
    const a = mockFetch([['https://registry.npmjs.org/', () => json({ error: 'Not found' }, 404)]]);
    const b = mockFetch([['https://registry.npmjs.org/', () => json({}, 429)]]);
    expect((await npmProbe.run(t, ctx(a)))[0]!.state).toBe('dead');
    expect((await npmProbe.run(t, ctx(b)))[0]!.state).toBe('unknown');
  });
  it('encodes scoped package names', async () => {
    const f = mockFetch([['https://registry.npmjs.org/', () => json(doc())]]);
    await npmProbe.run(buildTarget('npm:@scope/pkg'), ctx(f));
    expect(f.calls[0]).toBe('https://registry.npmjs.org/@scope%2Fpkg');
  });
});

describe('x via fxtwitter', () => {
  const FX = 'https://api.fxtwitter.com/2/profile/';
  const user = (description: string) => json({ code: 200, message: 'OK', user: { screen_name: 'jane', description, followers: 10 } });
  const statuses = (days: number) => json({ code: 200, results: [{ created_timestamp: Math.floor(Date.parse(daysAgo(days)) / 1000) }] });

  it('bio "EX vp product" is stale', async () => {
    const f = mockFetch([
      [/statuses$/, () => statuses(5)],
      [FX, () => user('EX vp product @acme. now building.')],
    ]);
    const rs = await xProbe.run(buildTarget('@jane'), ctx(f));
    const p = rs.find((r) => r.signal === 'x-profile')!;
    expect(p.state).toBe('dead');
    expect(p.kind).toBe('stale');
    expect(p.summary).toMatch(/EX vp product/);
  });

  it.each([
    ['ex-Google, now at Acme', true],
    ['formerly @acmehq', true],
    ['Acme has been acquired by Globex', true],
    ['This account is no longer maintained', true],
    ['Exploring the frontier of payments', false],
    ['VP product @acme', false],
    ['Next-gen exchange', false],
  ])('bioStaleness(%j) -> %s', (bio, stale) => {
    expect(!!bioStaleness(bio)).toBe(stale);
  });

  it('clean JSON 404 is dead (gone)', async () => {
    const f = mockFetch([[FX, () => json({ code: 404, message: 'User not found' }, 404)]]);
    const rs = await xProbe.run(buildTarget('@nobody'), ctx(f));
    expect(rs[0]!.state).toBe('dead');
  });

  it('429 is UNKNOWN, never dead', async () => {
    const f = mockFetch([[FX, () => json({ code: 429 }, 429)]]);
    const rs = await xProbe.run(buildTarget('@jane'), ctx(f));
    expect(rs[0]!.state).toBe('unknown');
    expect(rs[0]!.unknownReason).toBe('error');
  });

  it('v1-style 302 to the FxEmbed repo is UNKNOWN, not "not found"', async () => {
    const f = mockFetch([[FX, () => redirect('https://github.com/FxEmbed/FxEmbed', 302)]]);
    const rs = await xProbe.run(buildTarget('@jane'), ctx(f));
    expect(rs[0]!.state).toBe('unknown');
    expect(rs[0]!.summary).toMatch(/redirect/);
  });

  it('last tweet over a year ago is stale; recent is alive', async () => {
    const old = mockFetch([
      [/statuses$/, () => statuses(500)],
      [FX, () => user('building')],
    ]);
    const fresh = mockFetch([
      [/statuses$/, () => statuses(2)],
      [FX, () => user('building')],
    ]);
    expect((await xProbe.run(buildTarget('@jane'), ctx(old))).find((r) => r.signal === 'x-activity')!.state).toBe('dead');
    expect((await xProbe.run(buildTarget('@jane'), ctx(fresh))).find((r) => r.signal === 'x-activity')!.state).toBe('alive');
  });

  it('timeline error does not poison the profile signal', async () => {
    const f = mockFetch([
      [/statuses$/, () => json({}, 500)],
      [FX, () => user('building')],
    ]);
    const rs = await xProbe.run(buildTarget('@jane'), ctx(f));
    expect(rs.find((r) => r.signal === 'x-profile')!.state).toBe('alive');
    expect(rs.find((r) => r.signal === 'x-activity')!.unknownReason).toBe('error');
  });
});

describe('jobs (Greenhouse / Ashby / Lever)', () => {
  const GHB = 'https://boards-api.greenhouse.io/';
  const ASH = 'https://api.ashbyhq.com/';
  const LEV = 'https://api.lever.co/';

  it('open roles on any board is alive', async () => {
    const f = mockFetch([
      [GHB, () => json({ status: 404, error: 'Job not found' }, 404)],
      [ASH, () => json({ jobs: [{ isListed: true }, { isListed: true }, { isListed: false }] })],
      [LEV, () => json({ ok: false, error: 'Document not found' }, 404)],
    ]);
    const [r] = await jobsProbe.run(buildTarget('linear.app'), ctx(f));
    expect(r!.state).toBe('alive');
    expect(r!.summary).toMatch(/2 open role/);
  });

  it('no board anywhere is inconclusive, NOT dead', async () => {
    const f = mockFetch([[/./, () => json({}, 404)]]);
    const [r] = await jobsProbe.run(buildTarget('acme.test'), ctx(f));
    expect(r!.state).toBe('unknown');
    expect(r!.unknownReason).toBe('inconclusive');
  });

  it('errors with no board found is unknown(error)', async () => {
    const f = mockFetch([
      [GHB, () => json({}, 503)],
      [ASH, () => json({}, 404)],
      [LEV, () => 'network-error'],
    ]);
    const [r] = await jobsProbe.run(buildTarget('acme.test'), ctx(f));
    expect(r!.unknownReason).toBe('error');
  });

  it('existing board with zero roles is weakly stale', async () => {
    const f = mockFetch([
      [GHB, () => json({ jobs: [] })],
      [/./, () => json({}, 404)],
    ]);
    const [r] = await jobsProbe.run(buildTarget('acme.test'), ctx(f));
    expect(r!.state).toBe('dead');
    expect(r!.kind).toBe('stale');
    expect(r!.weight).toBeLessThan(0.5);
  });

  it('slug candidates', () => {
    expect(slugCandidates(buildTarget('Acme Labs')).slugs).toEqual(['acme']);
    expect(slugCandidates(buildTarget('stripe.com')).slugs).toEqual(['stripe']);
    expect(slugCandidates(buildTarget('x.com', { ats: 'Custom' }))).toEqual({ slugs: ['custom'], guessed: false });
  });
});

describe('wayback', () => {
  it('old last capture is stale, only when enabled', async () => {
    const f = mockFetch([
      [
        'https://web.archive.org/',
        () =>
          json([
            ['timestamp', 'statuscode', 'digest'],
            ['20210101000000', '200', 'A'],
            ['20220301120000', '200', 'B'],
          ]),
      ],
    ]);
    const t = buildTarget('old.test');
    expect(waybackProbe.applies(t, {})).toBe(false);
    const [r] = await waybackProbe.run(t, ctx(f, { options: { wayback: true } }));
    expect(r!.state).toBe('dead');
    expect(r!.summary).toMatch(/2022-03-01/);
  });
});
