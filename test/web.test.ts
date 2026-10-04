import { describe, expect, it } from 'vitest';
import { dnsProbe } from '../src/signals/dns.js';
import { tlsProbe } from '../src/signals/tls.js';
import { webProbe } from '../src/signals/web.js';
import { buildTarget } from '../src/target.js';
import { ctx, html, LONG_TEXT, mockFetch, NOW, redirect } from './helpers.js';

const get = (rs: Awaited<ReturnType<typeof webProbe.run>>, name: string) => rs.find((r) => r.signal === name)!;

describe('web probe: http + hosting + content', () => {
  it('live site that mentions its name', async () => {
    const f = mockFetch([['https://acme.test/', () => html(`<title>Acme</title><p>Acme builds rockets. ${LONG_TEXT}</p>`)]]);
    const rs = await webProbe.run(buildTarget('acme.test'), ctx(f));
    expect(get(rs, 'http').state).toBe('alive');
    expect(get(rs, 'hosting').state).toBe('alive');
    expect(get(rs, 'content').state).toBe('alive');
  });

  it('HTTP 402 on a host is a suspension page, not a paywall', async () => {
    const f = mockFetch([['https://perps.test/', () => html('Payment required', 402)]]);
    const rs = await webProbe.run(buildTarget('perps.test'), ctx(f));
    const h = get(rs, 'hosting');
    expect(h.state).toBe('dead');
    expect(h.kind).toBe('gone');
    expect(h.summary).toMatch(/402/);
    expect(get(rs, 'content').state).toBe('unknown');
  });

  it('detects a paused Vercel deployment from the header even on 200', async () => {
    const f = mockFetch([['https://app.test/', () => html('<h1>paused</h1>', 402, { 'x-vercel-error': 'DEPLOYMENT_DISABLED' })]]);
    const rs = await webProbe.run(buildTarget('app.test'), ctx(f));
    expect(get(rs, 'hosting').summary).toMatch(/Vercel/);
  });

  it.each([
    ['Render', '<h1>This service has been suspended.</h1> Render'],
    ['Netlify', '<title>Site not available</title> This site has been suspended. Netlify'],
    ['Parked', '<h1>This domain is for sale!</h1><a>Buy this domain</a>'],
    ['GitHub Pages', "There isn't a GitHub Pages site here."],
    ['Heroku', '<title>Heroku | No such app</title>'],
  ])('detects %s pages', async (_, body) => {
    const f = mockFetch([['https://x.test/', () => html(body)]]);
    const rs = await webProbe.run(buildTarget('x.test'), ctx(f));
    expect(get(rs, 'hosting').state).toBe('dead');
  });

  it('content mismatch: domain now serves an unrelated store', async () => {
    const page = `<html><head><title>トレンド服 | Fashion Online Store</title><link rel="canonical" href="https://helvetia-advisory.test/"></head>
      <body>新作アイテム入荷 summer collection dresses shirts ${LONG_TEXT}</body></html>`;
    const f = mockFetch([['https://helvetia-advisory.test/', () => html(page)]]);
    const rs = await webProbe.run(buildTarget('helvetia-advisory.test', { name: 'Helvetia Advisory AG' }), ctx(f));
    const c = get(rs, 'content');
    expect(c.state).toBe('dead');
    expect(c.summary).toMatch(/no longer mentions "Helvetia Advisory AG"/);
    // the canonical link containing the domain must not count as a mention
    expect(c.evidence.matchedVariant).toBeUndefined();
  });

  it('suffix-stripped name still matches', async () => {
    const f = mockFetch([['https://h.test/', () => html(`<p>Welcome to Helvetia Advisory. ${LONG_TEXT}</p>`)]]);
    const rs = await webProbe.run(buildTarget('h.test', { name: 'Helvetia Advisory AG' }), ctx(f));
    expect(get(rs, 'content').state).toBe('alive');
  });

  it('thin JS-rendered page is inconclusive, not dead', async () => {
    const f = mockFetch([['https://spa.test/', () => html('<div id="root"></div><script src="/a.js"></script>')]]);
    const rs = await webProbe.run(buildTarget('spa.test', { name: 'Zebra' }), ctx(f));
    expect(get(rs, 'content').state).toBe('unknown');
    expect(get(rs, 'content').unknownReason).toBe('inconclusive');
  });

  it('5xx is an error, not dead', async () => {
    const f = mockFetch([['https://down.test/', () => html('oops', 503)]]);
    const rs = await webProbe.run(buildTarget('down.test'), ctx(f));
    expect(get(rs, 'http').state).toBe('unknown');
    expect(get(rs, 'http').unknownReason).toBe('error');
  });

  it('timeout is an error, not dead', async () => {
    const f = mockFetch([['https://slow.test/', () => 'timeout']]);
    const rs = await webProbe.run(buildTarget('slow.test'), ctx(f));
    expect(rs.every((r) => r.state === 'unknown')).toBe(true);
    expect(get(rs, 'http').unknownReason).toBe('error');
  });

  it('records a cross-site redirect', async () => {
    const f = mockFetch([
      ['https://atom.test/', () => redirect('https://blog.other.test/sunsetting-atom')],
      ['https://blog.other.test/', () => html(`<title>Sunsetting Atom</title> atom ${LONG_TEXT}`)],
    ]);
    const rs = await webProbe.run(buildTarget('atom.test'), ctx(f));
    expect(get(rs, 'http').summary).toMatch(/redirects to blog\.other\.test/);
    expect(get(rs, 'http').evidence.chain).toHaveLength(2);
  });

  it('connection refused on both schemes is a (confirmable) negative', async () => {
    const f = mockFetch([[/^https?:\/\/gone\.test\//, () => 'refused']]);
    const rs = await webProbe.run(buildTarget('gone.test'), ctx(f));
    expect(get(rs, 'http').state).toBe('dead');
    expect(f.calls).toEqual(['https://gone.test/', 'http://gone.test/']);
  });
});

describe('dns probe', () => {
  const t = buildTarget('x.test');
  it('NXDOMAIN is dead', async () => {
    const rs = await dnsProbe.run(t, ctx(mockFetch([]), { dns: async () => ({ ok: false, code: 'ENOTFOUND', message: '' }) }));
    expect(rs[0]!.state).toBe('dead');
  });
  it('SERVFAIL / timeout is unknown(error)', async () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED']) {
      const rs = await dnsProbe.run(t, ctx(mockFetch([]), { dns: async () => ({ ok: false, code, message: '' }) }));
      expect(rs[0]!.state).toBe('unknown');
      expect(rs[0]!.unknownReason).toBe('error');
    }
  });
  it('resolving is alive', async () => {
    const rs = await dnsProbe.run(t, ctx(mockFetch([])));
    expect(rs[0]!.state).toBe('alive');
  });
});

describe('tls probe', () => {
  const t = buildTarget('x.test');
  it('expired certificate is stale', async () => {
    const tls = async () => ({
      ok: true as const,
      validFrom: '2024-01-01T00:00:00Z',
      validTo: '2025-01-01T00:00:00Z',
      authorized: false,
      authorizationError: 'CERT_HAS_EXPIRED',
    });
    const rs = await tlsProbe.run(t, ctx(mockFetch([]), { tls }));
    expect(rs[0]!.state).toBe('dead');
    expect(rs[0]!.kind).toBe('stale');
    expect(rs[0]!.summary).toMatch(/expired/);
  });
  it('handshake failure is unknown(error)', async () => {
    const rs = await tlsProbe.run(t, ctx(mockFetch([]), { tls: async () => ({ ok: false, code: 'ECONNRESET', message: '' }) }));
    expect(rs[0]!.unknownReason).toBe('error');
  });
  it('valid certificate is alive', async () => {
    const rs = await tlsProbe.run(t, ctx(mockFetch([]), { now: () => NOW }));
    expect(rs[0]!.state).toBe('alive');
  });
});

describe('expired hosting page (real-world: theranos.com)', () => {
  it('a DNS-host expiry page is a dead hosting signal even with HTTP 200', async () => {
    const f = mockFetch([['https://theranos.test/', () => html('<title>Expired DNS Hosting Services | DNS Made Easy</title>')]]);
    const rs = await webProbe.run(buildTarget('theranos.test'), ctx(f));
    expect(get(rs, 'http').state).toBe('alive');
    expect(get(rs, 'hosting').state).toBe('dead');
  });

  it('nothing on 443 is inconclusive, not an error', async () => {
    const rs = await tlsProbe.run(
      buildTarget('x.test'),
      ctx(mockFetch([]), { tls: async () => ({ ok: false, code: 'ECONNREFUSED', message: '' }) }),
    );
    expect(rs[0]!.unknownReason).toBe('inconclusive');
  });
});

describe('absorbed or shut down', () => {
  it('a "Sunsetting X" page is a shutdown notice (real-world: atom.io)', async () => {
    const f = mockFetch([
      ['https://atom.test/', () => redirect('https://blog.other.test/sunsetting-atom')],
      ['https://blog.other.test/', () => html(`<title>Sunsetting Atom - The Blog</title><h1>Sunsetting Atom</h1> ${LONG_TEXT}`)],
    ]);
    const rs = await webProbe.run(buildTarget('atom.test', { name: 'Atom' }), ctx(f));
    expect(get(rs, 'content').state).toBe('dead');
    expect(get(rs, 'content').summary).toMatch(/shutdown notice/);
    expect(get(rs, 'http').state).toBe('dead');
  });

  it('shutdown words in body text alone do not count', async () => {
    const f = mockFetch([
      [
        'https://acme.test/',
        () => html(`<title>Acme</title><h1>Acme</h1><p>We help teams wind down legacy systems. Acme. ${LONG_TEXT}</p>`),
      ],
    ]);
    const rs = await webProbe.run(buildTarget('acme.test'), ctx(f));
    expect(get(rs, 'content').state).toBe('alive');
  });

  it('a rebrand redirect that still names the company stays balanced', async () => {
    const f = mockFetch([
      ['https://old.test/', () => redirect('https://newbrand.test/')],
      ['https://newbrand.test/', () => html(`<title>Newbrand (formerly Old)</title><p>Old is now Newbrand. ${LONG_TEXT}</p>`)],
    ]);
    const rs = await webProbe.run(buildTarget('old.test', { name: 'Old' }), ctx(f));
    expect(get(rs, 'content').state).toBe('alive');
  });
});
