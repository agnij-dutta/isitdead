import { alive, daysBetween, dead, fromApiError, humanAge, inconclusive, type Probe } from '../context.js';
import { classifyApi, safeJson } from '../http.js';

function parseTs(ts: string): Date {
  return new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10) || 0, +ts.slice(10, 12) || 0));
}

/**
 * Optional: Wayback Machine CDX. collapse=digest drops consecutive identical
 * captures, so the last row is the most recent capture whose content changed.
 */
export const waybackProbe: Probe = {
  id: 'wayback',
  applies: (t, o) => !!t.domain && !!o.wayback,
  async run(t, ctx) {
    const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(t.domain!)}&output=json&fl=timestamp,statuscode,digest&filter=statuscode:200&collapse=digest&limit=-3`;
    const r = await ctx.http.get(url, { fresh: ctx.fresh, timeoutMs: 30_000 });
    const o = classifyApi(r);
    if (o.kind === 'error') return [fromApiError(ctx, 'wayback', 'Wayback CDX', o, url)];
    if (o.kind === 'absent') return [inconclusive(ctx, 'wayback', 'Wayback has no index for this domain', { source: url })];
    const rows = r.ok ? safeJson<string[][]>(r.body) : undefined;
    const data = (rows ?? []).slice(1).filter((x) => x[0]);
    if (!data.length) return [inconclusive(ctx, 'wayback', 'no successful Wayback captures', { source: url })];
    const last = data[data.length - 1]!;
    const when = parseTs(last[0]!);
    const days = daysBetween(when, ctx.now());
    const ev = { lastChangedCapture: when.toISOString(), daysSince: days, rows: data };
    const line = `Wayback: last capture with changed content ${humanAge(days)} (${when.toISOString().slice(0, 10)})`;
    if (days <= 120) return [alive(ctx, 'wayback', 0.2, line, { source: url, evidence: ev })];
    if (days <= 730) return [inconclusive(ctx, 'wayback', line, { source: url, evidence: ev })];
    return [dead(ctx, 'wayback', 'stale', 0.4, line, { source: url, evidence: ev })];
  },
};
