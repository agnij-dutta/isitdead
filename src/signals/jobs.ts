import { alive, dead, errored, inconclusive, type Probe } from '../context.js';
import { classifyApi, safeJson } from '../http.js';
import type { Target } from '../types.js';

interface Board {
  ats: 'greenhouse' | 'ashby' | 'lever';
  url: (slug: string) => string;
  count: (json: unknown) => number | undefined;
}

export const LEVER_LIMIT = 100;

export const BOARDS: Board[] = [
  {
    ats: 'greenhouse',
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs`,
    count: (j) => (Array.isArray((j as { jobs?: unknown[] })?.jobs) ? (j as { jobs: unknown[] }).jobs.length : undefined),
  },
  {
    ats: 'ashby',
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
    count: (j) => {
      const jobs = (j as { jobs?: Array<{ isListed?: boolean }> })?.jobs;
      return Array.isArray(jobs) ? jobs.filter((x) => x.isListed !== false).length : undefined;
    },
  },
  {
    ats: 'lever',
    // Lever returns full descriptions (6 MB for big boards); cap the page.
    url: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json&limit=${LEVER_LIMIT}`,
    count: (j) => (Array.isArray(j) ? j.length : undefined),
  },
];

export function slugCandidates(t: Target): { slugs: string[]; guessed: boolean } {
  if (t.ats) return { slugs: [t.ats.toLowerCase()], guessed: false };
  const set = new Set<string>();
  if (t.name) {
    const n = t.name.toLowerCase().replace(/\b(inc|llc|ltd|gmbh|ag|corp|labs)\.?$/i, '').trim();
    set.add(n.replace(/[^a-z0-9]/g, ''));
    if (/\s/.test(n)) set.add(n.replace(/[^a-z0-9]+/g, '-'));
  }
  if (t.domain) set.add(t.domain.replace(/^www\./, '').split('.')[0]!.toLowerCase());
  return { slugs: [...set].filter((s) => s.length >= 2).slice(0, 2), guessed: true };
}

/**
 * Keyless ATS boards. An open role is strong evidence of life. No board at all
 * is NOT evidence of death (many companies use other ATSes); it is reported
 * as inconclusive. A board that exists with zero postings is a weak stale signal.
 */
export const jobsProbe: Probe = {
  id: 'jobs',
  applies: (t) => !!(t.ats || t.name || t.domain),
  async run(t, ctx) {
    const { slugs, guessed } = slugCandidates(t);
    const found: Array<{ ats: string; slug: string; count: number; url: string }> = [];
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
        else {
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
      const capped = withJobs.some((x) => x.ats === 'lever' && x.count >= LEVER_LIMIT) ? '+' : '';
      return [alive(ctx, 'jobs', guessed ? 0.8 : 1.0, `${total}${capped} open role(s) on ${withJobs.map((x) => `${x.ats}/${x.slug}`).join(', ')}${guessNote}`, { source: f.url, evidence: ev })];
    }
    if (found.length) {
      const f = found[0]!;
      return [dead(ctx, 'jobs', 'stale', 0.3, `job board exists on ${f.ats}/${f.slug} but has 0 open roles`, { source: f.url, evidence: ev })];
    }
    if (errors.length) {
      return [errored(ctx, 'jobs', `job board lookup errored on ${errors.map((e) => `${e.ats}/${e.slug} (${e.reason})`).join('; ')} (not counted as dead)`, { evidence: ev })];
    }
    return [inconclusive(ctx, 'jobs', `no public Greenhouse/Ashby/Lever board for ${slugs.join(', ')} (absence of evidence, not counted)`, { evidence: ev })];
  },
};
