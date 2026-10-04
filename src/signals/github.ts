import { alive, daysBetween, dead, fromApiError, humanAge, inconclusive, type Probe } from '../context.js';
import { classifyApi, safeJson } from '../http.js';

interface Repo {
  name: string;
  full_name: string;
  fork: boolean;
  archived: boolean;
  pushed_at: string | null;
  stargazers_count?: number;
}

/**
 * The cheapest check that settles most cases: list public repos sorted by
 * last push. /users/{name}/repos works for both users and organisations,
 * so one request covers both (unauthenticated quota is 60/hour).
 */
export const githubProbe: Probe = {
  id: 'github',
  applies: (t) => !!t.github,
  async run(t, ctx) {
    const owner = t.github!;
    const url = `https://api.github.com/users/${encodeURIComponent(owner)}/repos?sort=pushed&direction=desc&per_page=100&type=owner`;
    const r = await ctx.http.get(url, { fresh: ctx.fresh, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
    const o = classifyApi(r);
    if (o.kind === 'error') return [fromApiError(ctx, 'github', `GitHub lookup for ${owner}`, o, url)];
    if (o.kind === 'absent') {
      return [dead(ctx, 'github', 'gone', 0.8, `no GitHub user or org named "${owner}" (clean 404)`, { source: url, evidence: { status: o.status } })];
    }
    const repos = r.ok ? safeJson<Repo[]>(r.body) : undefined;
    if (!Array.isArray(repos)) return [inconclusive(ctx, 'github', 'GitHub returned an unparseable body', { source: url })];
    if (repos.length === 0) {
      return [dead(ctx, 'github', 'stale', 0.3, `GitHub account "${owner}" exists but has no public repos`, { source: url, evidence: { repoCount: 0 } })];
    }

    const now = ctx.now();
    const forks = repos.filter((x) => x.fork);
    const originals = repos.filter((x) => !x.fork);
    const archived = repos.filter((x) => x.archived);
    const liveOriginals = originals.filter((x) => !x.archived);
    const newest = (list: Repo[]) =>
      list.filter((x) => x.pushed_at).sort((a, b) => Date.parse(b.pushed_at!) - Date.parse(a.pushed_at!))[0];
    const top = newest(liveOriginals);
    const topAny = newest(repos);
    const evidence = {
      repoCount: repos.length,
      truncated: repos.length === 100,
      forks: forks.length,
      originals: originals.length,
      archived: archived.length,
      newestOriginal: top ? { name: top.full_name, pushedAt: top.pushed_at } : undefined,
      newestAny: topAny ? { name: topAny.full_name, pushedAt: topAny.pushed_at, fork: topAny.fork } : undefined,
      forkNames: forks.slice(0, 5).map((x) => x.full_name),
    };

    if (archived.length === repos.length) {
      return [dead(ctx, 'github', 'gone', 1.0, `all ${repos.length} public repos are archived (read-only): explicitly end-of-life`, { source: url, evidence })];
    }
    if (liveOriginals.length === 0) {
      const age = topAny?.pushed_at ? humanAge(daysBetween(new Date(topAny.pushed_at), now)) : 'unknown';
      return [
        dead(ctx, 'github', 'stale', 0.9, `every non-archived repo is a fork (${forks.slice(0, 3).map((f) => f.name).join(', ')}); no original code. Last push ${age}`, {
          source: url,
          evidence,
        }),
      ];
    }
    const days = daysBetween(new Date(top!.pushed_at!), now);
    const forkNote = forks.length > originals.length ? `; ${forks.length} of ${repos.length} repos are forks` : '';
    const archNote = archived.length ? `; ${archived.length} archived` : '';
    const line = `last push to an original repo ${humanAge(days)} (${top!.name})${forkNote}${archNote}`;
    const ev = { ...evidence, daysSinceOriginalPush: days };
    if (days <= 90) return [alive(ctx, 'github', 1.0, line, { source: url, evidence: ev })];
    if (days <= 180) return [alive(ctx, 'github', 0.4, line, { source: url, evidence: ev })];
    if (days <= 365) return [dead(ctx, 'github', 'stale', 0.5, line, { source: url, evidence: ev })];
    return [dead(ctx, 'github', 'stale', 1.0, line, { source: url, evidence: ev })];
  },
};
