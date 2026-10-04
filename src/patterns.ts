/**
 * Fingerprints of pages that a host serves when the customer's site is gone:
 * unpaid, paused, suspended, deleted, or the domain is parked for sale.
 * These pages usually return 200 or 402, so status alone lies.
 */
export interface Fingerprint {
  id: string;
  label: string;
  kind: 'suspended' | 'parked' | 'missing';
  /** Matched against lowercased HTML. */
  body?: RegExp[];
  /** Header name -> regex on value. */
  headers?: Record<string, RegExp>;
}

export const FINGERPRINTS: Fingerprint[] = [
  {
    id: 'vercel-paused',
    label: 'Vercel deployment paused/disabled',
    kind: 'suspended',
    headers: { 'x-vercel-error': /DEPLOYMENT_(DISABLED|PAUSED|BLOCKED)|PAYMENT_REQUIRED/i },
    body: [
      /deployment_(disabled|paused|blocked)/,
      /this deployment (is|has been) (temporarily )?(paused|disabled)/,
      /402: payment_required/,
    ],
  },
  {
    id: 'vercel-not-found',
    label: 'Vercel deployment not found',
    kind: 'missing',
    headers: { 'x-vercel-error': /DEPLOYMENT_NOT_FOUND|NOT_FOUND/i },
    body: [/deployment_not_found/],
  },
  {
    id: 'netlify',
    label: 'Netlify site suspended or missing',
    kind: 'suspended',
    body: [/this site (has been|is) (suspended|disabled)/, /netlify.{0,80}site not (found|available)/, /site not available.{0,200}netlify/],
  },
  {
    id: 'render',
    label: 'Render service suspended',
    kind: 'suspended',
    body: [/this service has been suspended/, /service suspended.{0,200}render/, /render.{0,200}service (is )?suspended/],
  },
  {
    id: 'heroku',
    label: 'Heroku app missing',
    kind: 'missing',
    body: [/no such app.{0,200}heroku/, /heroku \| no such app/, /there('|&#39;)s nothing here, yet/],
  },
  {
    id: 'github-pages',
    label: 'GitHub Pages site missing',
    kind: 'missing',
    body: [/there isn('|&#39;)t a github pages site here/],
  },
  {
    id: 'cpanel-suspended',
    label: 'Hosting account suspended',
    kind: 'suspended',
    body: [/account suspended/, /this account has been suspended/, /website is suspended/, /site has been suspended/],
  },
  {
    id: 'shopify-closed',
    label: 'Shopify store closed',
    kind: 'suspended',
    body: [/sorry, this (shop|store) is currently unavailable/],
  },
  {
    id: 'firebase-missing',
    label: 'Firebase Hosting site not found',
    kind: 'missing',
    body: [/site not found.{0,300}firebase/],
  },
  {
    id: 'fly-missing',
    label: 'Fly.io app missing',
    kind: 'missing',
    headers: { server: /^Fly\// },
    body: [/404 not found.{0,80}fly\.io/],
  },
  {
    id: 'dns-host-expired',
    label: 'DNS/hosting provider expiry page',
    kind: 'suspended',
    // e.g. theranos.com serves "Expired DNS Hosting Services | DNS Made Easy"
    body: [
      /expired dns hosting services/,
      /dns (hosting )?(service|account) (has )?expired/,
      /this (dns|hosting) (account|plan) has expired/,
    ],
  },
  {
    id: 'parked',
    label: 'Parked / for-sale domain',
    kind: 'parked',
    body: [
      /this domain (name )?(is|may be) for sale/,
      /buy this domain/,
      /the domain .{0,80} is for sale/,
      /domain (is )?parked/,
      /parked (free )?(courtesy of|by) /,
      /this web page is parked/,
      /hugedomains\.com/,
      /\b(sedo|afternic|bodis|parkingcrew|parklogic)\b|\bdan\.com\b|\bundeveloped\.com\b/,
      /domain has expired/,
      /this domain has (recently )?expired/,
      /renew (this|your) domain/,
    ],
  },
];

export interface FingerprintHit {
  id: string;
  label: string;
  kind: Fingerprint['kind'];
  matched: string;
}

export function detectHostingPage(status: number, headers: Record<string, string>, html: string): FingerprintHit | undefined {
  const lower = html.toLowerCase();
  for (const fp of FINGERPRINTS) {
    for (const [h, re] of Object.entries(fp.headers ?? {})) {
      const v = headers[h];
      // Fly server header alone is not enough; require the body match too.
      if (v && re.test(v) && fp.id !== 'fly-missing') return { id: fp.id, label: fp.label, kind: fp.kind, matched: `${h}: ${v}` };
    }
    for (const re of fp.body ?? []) {
      // Parked-page markers like "sedo" can appear on any page in a footer or ad.
      // Only trust them on small pages, which is what parking pages are.
      if ((fp.kind === 'parked' || fp.id === 'cpanel-suspended') && lower.length > 60_000) continue;
      const m = lower.match(re);
      if (m) return { id: fp.id, label: fp.label, kind: fp.kind, matched: m[0].slice(0, 120) };
    }
  }
  if (status === 402) {
    return {
      id: 'http-402',
      label: 'HTTP 402: host non-payment page (not a paywall)',
      kind: 'suspended',
      matched: 'status 402',
    };
  }
  return undefined;
}

/** Generic company suffixes stripped when matching names on a page. */
const SUFFIXES =
  /\b(inc|inc\.|llc|ltd|ltd\.|gmbh|ag|sa|sarl|bv|oy|ab|plc|corp|corporation|co|company|labs|protocol|technologies|technology|hq|app|io)\.?$/i;

export function nameVariants(name: string): string[] {
  const base = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const out = new Set<string>([base]);
  let stripped = base;
  for (let i = 0; i < 2; i++) stripped = stripped.replace(SUFFIXES, '').trim().replace(/[,]$/, '').trim();
  if (stripped.length >= 3) out.add(stripped);
  for (const v of [...out]) {
    const compact = v.replace(/[^a-z0-9]/g, '');
    if (compact.length >= 3) out.add(compact);
    const dashed = v.replace(/\s+/g, '-');
    out.add(dashed);
  }
  return [...out].filter((v) => v.length >= 2);
}

export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1]
    ? decodeEntities(m[1])
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200) || undefined
    : undefined;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', middot: '.' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Render dashes as plain hyphens in output.
      if (code === 8211 || code === 8212) return '-';
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

/** Visible-ish text: strip scripts, styles and tags. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does the page mention the entity? Searches the HTML with every occurrence
 * of the site's own hostnames removed, so a canonical link or asset URL on
 * a squatter's page does not count as a mention.
 */
export function mentionsName(html: string, name: string, hostsToIgnore: string[]): { found: boolean; variant?: string } {
  let hay = html.toLowerCase();
  for (const h of hostsToIgnore) {
    if (!h) continue;
    hay = hay.split(h.toLowerCase()).join(' ');
  }
  for (const v of nameVariants(name)) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(v)}([^a-z0-9]|$)`, 'i');
    if (re.test(hay)) return { found: true, variant: v };
  }
  return { found: false };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
