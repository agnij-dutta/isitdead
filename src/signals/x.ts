import { alive, daysBetween, dead, errored, fromApiError, humanAge, inconclusive, type Probe } from '../context.js';
import { classifyApi, safeJson } from '../http.js';
import type { SignalResult } from '../types.js';

/**
 * Bio phrases that mean "this is no longer true". Case-insensitive.
 * "ex vp product", "ex-Google", "formerly @acme", "acquired by", "we have moved".
 */
const STALE_BIO: RegExp[] = [
  /\bex[- ](?!\d)[a-z@]/i,
  /\bformer(ly)?\b/i,
  /\bpreviously\b/i,
  /\bretired\b/i,
  /\bdefunct\b/i,
  /\bshut(ting)? down\b/i,
  /\b(sunset|sunsetted|sunsetting)\b/i,
  /\bno longer\b/i,
  /\b(acquired|bought) by\b/i,
  /\bhas been acquired\b/i,
  /\bis now @\w+/i,
  /\b(we('| ha)ve|has) moved\b/i,
  /\bmoved to @\w+/i,
  /\bnot (actively )?maintained\b/i,
  /\b(archived|inactive|discontinued|deprecated)\b/i,
  /\bR\.?I\.?P\b/,
];

export function bioStaleness(bio: string): string | undefined {
  for (const re of STALE_BIO) {
    const m = bio.match(re);
    if (m) {
      const i = m.index ?? 0;
      return bio.slice(Math.max(0, i - 10), i + m[0].length + 25).replace(/\s+/g, ' ').trim();
    }
  }
  return undefined;
}

interface FxUser {
  screen_name?: string;
  name?: string;
  description?: string;
  followers?: number;
  statuses?: number;
  tweets?: number;
  joined?: string;
  protected?: boolean;
  website?: { url?: string } | null;
}

/**
 * Uses FxTwitter (keyless). We call the v2 profile endpoint because v1
 * answers an unknown handle with a 302 to the FxEmbed GitHub repo, which
 * is a redirect, not a "not found". v2 returns a clean JSON 404.
 */
export const xProbe: Probe = {
  id: 'x',
  applies: (t) => !!t.x,
  async run(t, ctx) {
    const h = t.x!.replace(/^@/, '');
    const url = `https://api.fxtwitter.com/2/profile/${encodeURIComponent(h)}`;
    const r = await ctx.http.get(url, { fresh: ctx.fresh, headers: { accept: 'application/json' } });
    const o = classifyApi(r);
    const body = r.ok ? safeJson<{ code?: number; message?: string; user?: FxUser }>(r.body) : undefined;
    if (o.kind === 'error') return [fromApiError(ctx, 'x-profile', `X profile @${h}`, o, url)];
    // fxtwitter mirrors the status in a JSON "code" field; trust the HTTP status first.
    if (o.kind === 'absent' || body?.code === 404) {
      return [dead(ctx, 'x-profile', 'gone', 0.7, `X account @${h} not found (deleted, renamed or suspended)`, { source: url, evidence: { status: r.ok ? r.status : undefined, message: body?.message } })];
    }
    if (!body?.user) {
      if (body?.code && body.code !== 200) return [errored(ctx, 'x-profile', `fxtwitter answered code ${body.code}: ${body.message ?? ''} (not counted as dead)`, { source: url })];
      return [errored(ctx, 'x-profile', 'fxtwitter returned no user object (not counted as dead)', { source: url })];
    }
    const u = body.user;
    const bio = u.description ?? '';
    const stale = bioStaleness(bio);
    const ev = { handle: u.screen_name, name: u.name, bio, followers: u.followers, tweets: u.statuses ?? u.tweets, joined: u.joined, protected: u.protected };
    const out: SignalResult[] = [];
    if (stale) {
      out.push(dead(ctx, 'x-profile', 'stale', 0.6, `@${h} bio looks stale: "${stale}"`, { source: url, evidence: { ...ev, staleMatch: stale } }));
    } else {
      out.push(alive(ctx, 'x-profile', 0.2, `@${h} exists (${u.followers ?? '?'} followers), bio has no staleness markers`, { source: url, evidence: ev }));
    }

    if (u.protected) {
      out.push(inconclusive(ctx, 'x-activity', `@${h} is protected; tweets not visible`, { source: url }));
      return out;
    }
    const surl = `https://api.fxtwitter.com/2/profile/${encodeURIComponent(h)}/statuses`;
    const sr = await ctx.http.get(surl, { fresh: ctx.fresh, headers: { accept: 'application/json' } });
    const so = classifyApi(sr);
    if (so.kind !== 'found') {
      out.push(
        so.kind === 'error'
          ? fromApiError(ctx, 'x-activity', `X timeline @${h}`, so, surl)
          : inconclusive(ctx, 'x-activity', `timeline for @${h} not available`, { source: surl }),
      );
      return out;
    }
    const sb = sr.ok ? safeJson<{ results?: Array<{ created_timestamp?: number; created_at?: string }> }>(sr.body) : undefined;
    const stamps = (sb?.results ?? [])
      .map((x) => (x.created_timestamp ? x.created_timestamp * 1000 : x.created_at ? Date.parse(x.created_at) : NaN))
      .filter((n) => Number.isFinite(n));
    if (!stamps.length) {
      out.push(inconclusive(ctx, 'x-activity', `no tweets visible for @${h}`, { source: surl, evidence: { tweetCount: ev.tweets } }));
      return out;
    }
    const last = new Date(Math.max(...stamps));
    const days = daysBetween(last, ctx.now());
    const aev = { lastTweetAt: last.toISOString(), daysSinceLastTweet: days, sampled: stamps.length };
    const line = `last tweet ${humanAge(days)} (${last.toISOString().slice(0, 10)})`;
    if (days <= 60) out.push(alive(ctx, 'x-activity', 0.7, line, { source: surl, evidence: aev }));
    else if (days <= 365) out.push(alive(ctx, 'x-activity', 0.2, line, { source: surl, evidence: aev }));
    else out.push(dead(ctx, 'x-activity', 'stale', 0.6, line, { source: surl, evidence: aev }));
    return out;
  },
};
