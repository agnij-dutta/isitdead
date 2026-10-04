import { alive, dead, errored, inconclusive, type Probe } from '../context.js';
import { classifyApi, safeJson } from '../http.js';
import type { Target } from '../types.js';

interface Board {
  ats: 'greenhouse' | 'ashby' | 'lever';
  url: (slug: string) => string;
  /** Number of listed postings in a parsed body, or undefined if the shape is unexpected. */
  count: (json: unknown) => number | undefined;
  /**
   * Lower bound on postings in a body that was cut off at the size cap, by
   * counting a per-posting marker. Undefined when the text proves nothing.
   */
  countPartial?: (text: string) => number | undefined;
}

/** Count regex matches, or undefined for zero (zero matches in a fragment proves nothing). */
const matches = (text: string, re: RegExp) => text.match(re)?.length || undefined;

export const LEVER_LIMIT = 100;

export const BOARDS: Board[] = [
  {
    ats: 'greenhouse',
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs`,
    count: (j) => (Array.isArray((j as { jobs?: unknown[] })?.jobs) ? (j as { jobs: unknown[] }).jobs.length : undefined),
    countPartial: (text) => matches(text, /"absolute_url"\s*:/g),
  },
  {
    ats: 'ashby',
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
    count: (j) => {
      const jobs = (j as { jobs?: Array<{ isListed?: boolean }> })?.jobs;
      return Array.isArray(jobs) ? jobs.filter((x) => x.isListed !== false).length : undefined;
    },
    // Ashby has no page-size parameter and returns full descriptions: a large
    // board is 10+ MB, past our body cap.
    countPartial: (text) => matches(text, /"isListed"\s*:\s*true/g),
  },
  {
    ats: 'lever',
    // Lever returns full descriptions (6 MB for big boards); cap the page.
    url: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json&limit=${LEVER_LIMIT}`,
    count: (j) => (Array.isArray(j) ? j.length : undefined),
    countPartial: (text) => matches(text, /"hostedUrl"\s*:/g),
  },
];

/** Board slugs to try: the explicit --ats slug, or up to two guesses from the name and domain. */
export function slugCandidates(t: Target): { slugs: string[]; guessed: boolean } {
  if (t.ats) return { slugs: [t.ats.toLowerCase()], guessed: false };
  const set = new Set<string>();
  if (t.name) {
    const n = t.name
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|gmbh|ag|corp|labs)\.?$/i, '')
      .trim();
    set.add(n.replace(/[^a-z0-9]/g, ''));
    if (/\s/.test(n)) set.add(n.replace(/[^a-z0-9]+/g, '-'));
  }
  if (t.domain)
    set.add(
      t.domain
        .replace(/^www\./, '')
        .split('.')[0]!
        .toLowerCase(),
    );
  return { slugs: [...set].filter((s) => s.length >= 2).slice(0, 2), guessed: true };
}

/**
 * Keyless ATS boards. An open role is strong evidence of life. No board at all
 * is NOT evidence of death (many companies use other ATSes); it is reported
 * as inconclusive. A board that exists with zero postings is a weak stale signal.
 */
export const jobsProbe: Probe = {
  id: 'jobs',
  signals: ['jobs'],
  applies: (t) => !!(t.ats || t.name || t.domain),
  async run(t, ctx) {
    const { slugs, guessed } = slugCandidates(t);
    const found: Array<{ ats: string; slug: string; count: number; url: string; partial?: boolean }> = [];
    const errors: Array<{ ats: string; slug: string; reason: string; url: string }> = [];
    const absent: string[] = [];
    for (const slug of slugs) {
      const results = await Promise.all(
        BOARDS.map(async (b) => {
          const url = b.url(slug);
          const r = await ctx.http.get(url, { fresh: ctx.fresh, headers: { accept: 'application/json' } });
          return { b, url, r, o: classifyApi(r) };
        }),
      );
      for (const { b, url, r, o } of results) {
        if (o.kind === 'error') errors.push({ ats: b.ats, slug, reason: o.reason, url });
        else if (o.kind === 'absent') absent.push(`${b.ats}/${slug}`);
        else if (r.ok && r.truncated) {
          // A cut-off body cannot prove "zero roles", only "at least N".
          const n = b.countPartial?.(r.body);
          if (n) found.push({ ats: b.ats, slug, count: n, url, partial: true });
          else errors.push({ ats: b.ats, slug, reason: 'response too large, truncated before any posting', url });
        } else {
          const n = r.ok ? b.count(safeJson(r.body)) : undefined;
          if (n === undefined) errors.push({ ats: b.ats, slug, reason: 'unparseable body', url });
          else found.push({ ats: b.ats, slug, count: n, url });
        }
      }
    }
    const ev = { slugs, slugsGuessed: guessed, found, errors, absent };
    const withJobs = found.filter((f) => f.count > 0).sort((a, b) => b.count - a.count);
    if (withJobs.length) {
      const f = withJobs[0]!;
      const total = withJobs.reduce((s, x) => s + x.count, 0);
      const guessNote = guessed ? ` (slug "${f.slug}" guessed from the name; verify it is the same company)` : '';
      const capped = withJobs.some((x) => x.partial || (x.ats === 'lever' && x.count >= LEVER_LIMIT)) ? '+' : '';
      return [
        alive(
          ctx,
          'jobs',
          guessed ? 0.8 : 1.0,
          `${total}${capped} open role(s) on ${withJobs.map((x) => `${x.ats}/${x.slug}`).join(', ')}${guessNote}`,
          { source: f.url, evidence: ev },
        ),
      ];
    }
    // An empty board is only a negative when every other board answered
    // cleanly: if one errored, the roles may be there.
    if (found.length && !errors.length) {
      const f = found[0]!;
      return [
        dead(ctx, 'jobs', 'stale', 0.3, `job board exists on ${f.ats}/${f.slug} but has 0 open roles`, { source: f.url, evidence: ev }),
      ];
    }
    if (errors.length) {
      return [
        errored(
          ctx,
          'jobs',
          `job board lookup errored on ${errors.map((e) => `${e.ats}/${e.slug} (${e.reason})`).join('; ')} (not counted as dead)`,
          { evidence: ev },
        ),
      ];
    }
    return [
      inconclusive(ctx, 'jobs', `no public Greenhouse/Ashby/Lever board for ${slugs.join(', ')} (absence of evidence, not counted)`, {
        evidence: ev,
      }),
    ];
  },
};
