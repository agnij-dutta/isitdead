import { alive, dead, errored, inconclusive, type Ctx, type Probe } from '../context.js';
import type { HttpResult } from '../http.js';
import { detectHostingPage, extractTitle, mentionsName, visibleText } from '../patterns.js';
import type { SignalResult, Target } from '../types.js';

const FALLBACK_TO_HTTP = new Set([
  'ECONNREFUSED',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
  'ECONNRESET',
]);

/** Crude registrable domain: good enough to tell "moved to another site". */
export function siteOf(host: string): string {
  const parts = host
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  const twoLevel = /^(co|com|net|org|gov|ac|edu)$/.test(parts[parts.length - 2] ?? '') && (parts[parts.length - 1] ?? '').length === 2;
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

/** GET the homepage over https, falling back to plain http only for TLS-level or refused-connection failures. */
async function fetchHome(domain: string, ctx: Ctx): Promise<{ r: HttpResult; attempts: string[] }> {
  const attempts: string[] = [];
  const opts = { follow: true, fresh: ctx.fresh, headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } };
  const https = `https://${domain}/`;
  attempts.push(https);
  const r = await ctx.http.get(https, opts);
  if (r.ok || !FALLBACK_TO_HTTP.has(r.code ?? '')) return { r, attempts };
  const http = `http://${domain}/`;
  attempts.push(http);
  const r2 = await ctx.http.get(http, opts);
  if (r2.ok) return { r: r2, attempts };
  // Both failed. "Refused on 443 and 80" is a clean negative only when BOTH
  // were refused. If https was refused but http timed out (or vice versa),
  // the honest answer is the error, so report the non-refused failure.
  if (r.code === 'ECONNREFUSED' && r2.code !== 'ECONNREFUSED') return { r: r2, attempts };
  // Otherwise keep the https error: it is usually the more informative one.
  return { r, attempts };
}

/**
 * One homepage fetch (redirects followed and recorded) yields three signals:
 *   http    : status and redirect chain; a cross-site redirect is weak "gone"
 *   hosting : host suspension, parked or missing-site pages (see patterns.ts)
 *   content : shutdown notice in the title/h1, or the page no longer names the entity
 */
export const webProbe: Probe = {
  id: 'web',
  signals: ['http', 'hosting', 'content'],
  applies: (t) => !!t.domain,
  async run(t, ctx) {
    const domain = t.domain!;
    const { r, attempts } = await fetchHome(domain, ctx);
    const chain = r.chain.map((h) => `${h.status} ${h.url}`);
    const source = attempts[attempts.length - 1];

    if (!r.ok) {
      const ev = { error: r.error, code: r.code, attempts, chain };
      const out: SignalResult[] = [];
      if (r.code === 'ECONNREFUSED') {
        out.push(dead(ctx, 'http', 'gone', 0.5, `${domain} resolves but refuses connections on 443 and 80`, { source, evidence: ev }));
      } else if (r.code === 'ENOTFOUND') {
        out.push(inconclusive(ctx, 'http', `${domain} did not resolve during fetch (see dns signal)`, { source, evidence: ev }));
      } else {
        out.push(
          errored(ctx, 'http', `fetching ${domain} failed: ${r.code ?? ''} ${r.error} (not counted as dead)`, { source, evidence: ev }),
        );
      }
      out.push(inconclusive(ctx, 'hosting', 'no page fetched, hosting check skipped', { source }));
      out.push(inconclusive(ctx, 'content', 'no page fetched, content check skipped', { source }));
      return out;
    }

    const s = r.status;
    const finalHost = safeHost(r.url) ?? domain;
    const movedSite = siteOf(finalHost) !== siteOf(domain) ? finalHost : undefined;
    const redirectNote = movedSite ? `, redirects to ${movedSite}` : r.chain.length > 1 ? ` after ${r.chain.length - 1} redirect(s)` : '';
    const title = extractTitle(r.body);
    const ev = { status: s, finalUrl: r.url, chain, title, redirectedToOtherSite: movedSite, server: r.headers['server'] };
    const out: SignalResult[] = [];

    // http
    if (s >= 200 && s < 300 && movedSite) {
      // The domain no longer hosts its own site. Fine for a rebrand (the content
      // check will find the name), a strong hint for an absorbed or sold company.
      out.push(dead(ctx, 'http', 'gone', 0.3, `no site of its own: ${domain} redirects to ${movedSite}`, { source, evidence: ev }));
    } else if (s >= 200 && s < 300) out.push(alive(ctx, 'http', 0.2, `HTTP ${s}${redirectNote}`, { source, evidence: ev }));
    else if (s === 402) out.push(dead(ctx, 'http', 'gone', 0.3, `HTTP 402${redirectNote}`, { source, evidence: ev }));
    else if (s === 404 || s === 410)
      out.push(dead(ctx, 'http', 'gone', 0.5, `homepage returns HTTP ${s}${redirectNote}`, { source, evidence: ev }));
    else if (s === 401 || s === 403)
      out.push(inconclusive(ctx, 'http', `HTTP ${s}: blocked or behind a bot wall, cannot judge`, { source, evidence: ev }));
    else if (s === 429 || s >= 500)
      out.push(errored(ctx, 'http', `HTTP ${s} from ${finalHost} (not counted as dead)`, { source, evidence: ev }));
    else out.push(inconclusive(ctx, 'http', `HTTP ${s}${redirectNote}`, { source, evidence: ev }));

    // hosting
    const hit = detectHostingPage(s, r.headers, r.body);
    if (hit) {
      const what =
        hit.kind === 'parked'
          ? 'domain is parked or for sale'
          : hit.kind === 'missing'
            ? 'host says the site no longer exists'
            : 'host has suspended the site';
      out.push(
        dead(ctx, 'hosting', 'gone', 1.0, `${hit.label}: ${what} (matched "${hit.matched}")`, {
          source: r.url,
          evidence: { ...hit, status: s },
        }),
      );
    } else if (s >= 200 && s < 300) {
      out.push(alive(ctx, 'hosting', movedSite ? 0 : 0.1, 'no suspended, parked or missing-site markers', { source: r.url }));
    } else {
      out.push(inconclusive(ctx, 'hosting', `no hosting markers on HTTP ${s} page`, { source: r.url }));
    }

    // content
    const ctype = r.headers['content-type'] ?? '';
    if (!(s >= 200 && s < 300)) {
      out.push(inconclusive(ctx, 'content', `content check skipped (HTTP ${s})`, { source: r.url }));
    } else if (hit) {
      out.push(inconclusive(ctx, 'content', 'content check skipped (host error or parked page)', { source: r.url }));
    } else if (ctype && !/html|xml|text\/plain/i.test(ctype)) {
      out.push(inconclusive(ctx, 'content', `content check skipped (content-type ${ctype})`, { source: r.url }));
    } else {
      out.push(contentSignal(t, ctx, r.body, [domain, `www.${domain.replace(/^www\./, '')}`, finalHost], r.url, title));
    }
    return out;
  },
};

/** Title or first heading announcing the end. Only these spots, never body text. */
const SHUTDOWN =
  /\b(sunsetting|sunset|shutting down|shut down|shutdown|farewell|goodbye|end of life|end-of-life|discontinued|winding down|wind down|closing down|has closed|(is|are) closing|ceased operations|thank you for everything)\b/i;

export function shutdownNotice(html: string): string | undefined {
  const spots = [
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)?.[1],
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, ' '),
  ];
  for (const s of spots) {
    const text = s?.replace(/\s+/g, ' ').trim();
    if (text && SHUTDOWN.test(text)) return text.slice(0, 160);
  }
  return undefined;
}

function contentSignal(t: Target, ctx: Ctx, html: string, ignoreHosts: string[], url: string, title?: string): SignalResult {
  const name = t.name ?? t.domain!;
  const notice = shutdownNotice(html);
  if (notice) {
    return dead(ctx, 'content', 'gone', 1.0, `page is a shutdown notice: "${notice}"`, { source: url, evidence: { name, title, notice } });
  }
  const m = mentionsName(html, name, ignoreHosts);
  const text = visibleText(html);
  const ev = { name, nameDerived: !!t.nameDerived, title, textLength: text.length, matchedVariant: m.variant };
  if (m.found) {
    return alive(ctx, 'content', 0.3, `page mentions "${m.variant}"${title ? ` (title: "${title}")` : ''}`, { source: url, evidence: ev });
  }
  if (text.length < 400) {
    return inconclusive(
      ctx,
      'content',
      `page is too thin to judge (${text.length} chars of text, likely JS-rendered); "${name}" not found`,
      { source: url, evidence: ev },
    );
  }
  return dead(
    ctx,
    'content',
    'gone',
    0.8,
    `page no longer mentions "${name}"${title ? `; title is "${title}"` : ''}: domain may now belong to someone else`,
    {
      source: url,
      evidence: ev,
    },
  );
}

function safeHost(u: string): string | undefined {
  try {
    return new URL(u).host;
  } catch {
    return undefined;
  }
}
