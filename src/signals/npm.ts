import { alive, daysBetween, dead, fromApiError, humanAge, inconclusive, type Probe } from '../context.js';
import { classifyApi, safeJson } from '../http.js';

interface Packument {
  name?: string;
  modified?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, { deprecated?: string | boolean }>;
}

export function npmUrl(pkg: string): string {
  // Scoped names keep the @ but encode the slash.
  return `https://registry.npmjs.org/${pkg.startsWith('@') ? '@' + encodeURIComponent(pkg.slice(1)) : encodeURIComponent(pkg)}`;
}

export const npmProbe: Probe = {
  id: 'npm',
  applies: (t) => !!t.npm,
  async run(t, ctx) {
    const pkg = t.npm!;
    const url = npmUrl(pkg);
    // Abbreviated metadata: small, includes "modified" and per-version deprecation.
    const r = await ctx.http.get(url, { fresh: ctx.fresh, headers: { accept: 'application/vnd.npm.install-v1+json' } });
    const o = classifyApi(r);
    if (o.kind === 'error') return [fromApiError(ctx, 'npm', `npm lookup for ${pkg}`, o, url)];
    if (o.kind === 'absent') return [dead(ctx, 'npm', 'gone', 0.8, `npm package "${pkg}" does not exist (clean 404)`, { source: url })];
    const doc = r.ok ? safeJson<Packument>(r.body) : undefined;
    const latest = doc?.['dist-tags']?.latest;
    if (!doc || !latest) return [inconclusive(ctx, 'npm', `npm package "${pkg}" has no latest dist-tag`, { source: url })];
    const deprecated = doc.versions?.[latest]?.deprecated;
    const modified = doc.modified;
    const days = modified ? daysBetween(new Date(modified), ctx.now()) : undefined;
    const ev = { latest, deprecated, modified, daysSinceModified: days, versionCount: Object.keys(doc.versions ?? {}).length };
    if (deprecated) {
      return [
        dead(ctx, 'npm', 'gone', 1.0, `${pkg}@${latest} is deprecated: "${String(deprecated).slice(0, 140)}"`, {
          source: url,
          evidence: ev,
        }),
      ];
    }
    if (days === undefined) return [inconclusive(ctx, 'npm', `${pkg}@${latest}: no modified date`, { source: url, evidence: ev })];
    const line = `${pkg}@${latest}, registry last updated ${humanAge(days)}`;
    if (days <= 180) return [alive(ctx, 'npm', 0.7, line, { source: url, evidence: ev })];
    if (days <= 730) return [alive(ctx, 'npm', 0.2, line, { source: url, evidence: ev })];
    return [dead(ctx, 'npm', 'stale', 0.6, line, { source: url, evidence: ev })];
  },
};
