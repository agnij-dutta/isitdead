import { connect } from 'node:tls';
import { alive, daysBetween, dead, errored, inconclusive, type Probe } from '../context.js';

export type TlsAnswer =
  | { ok: true; validFrom: string; validTo: string; issuer?: string; subject?: string; authorized: boolean; authorizationError?: string }
  | { ok: false; code: string; message: string };

export type TlsProber = (host: string) => Promise<TlsAnswer>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export const systemTls: TlsProber = (host) =>
  new Promise((resolve) => {
    const sock = connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
      const cert = sock.getPeerCertificate();
      const authErr = sock.authorizationError ? String(sock.authorizationError) : undefined;
      sock.end();
      if (!cert || !cert.valid_to) return resolve({ ok: false, code: 'ENOCERT', message: 'no peer certificate' });
      resolve({
        ok: true,
        validFrom: new Date(cert.valid_from).toISOString(),
        validTo: new Date(cert.valid_to).toISOString(),
        issuer: first(cert.issuer?.O ?? cert.issuer?.CN),
        subject: first(cert.subject?.CN),
        authorized: sock.authorized,
        authorizationError: authErr,
      });
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ ok: false, code: 'ETIMEDOUT', message: 'TLS handshake timed out' });
    });
    sock.on('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, code: e.code ?? 'ETLS', message: e.message }));
  });

export const tlsProbe: Probe = {
  id: 'tls',
  applies: (t) => !!t.domain,
  async run(t, ctx) {
    const host = t.domain!;
    const a = await ctx.tls(host);
    if (!a.ok && a.code === 'ECONNREFUSED') {
      // A clean answer, not a failure: nothing listens on 443.
      return [inconclusive(ctx, 'tls', `nothing listening on ${host}:443 (no HTTPS)`, { evidence: { ...a } })];
    }
    if (!a.ok && a.code === 'ENOTFOUND') {
      return [inconclusive(ctx, 'tls', `${host} did not resolve for TLS (see dns signal)`, { evidence: { ...a } })];
    }
    if (!a.ok) {
      return [errored(ctx, 'tls', `TLS check on ${host}:443 failed: ${a.code} (not counted as dead)`, { evidence: { ...a } })];
    }
    const now = ctx.now();
    const left = daysBetween(now, new Date(a.validTo));
    const ev = { ...a, daysLeft: left };
    if (left < 0) {
      return [
        dead(ctx, 'tls', 'stale', 0.7, `TLS certificate expired ${-left} days ago (${a.validTo.slice(0, 10)}): nobody is renewing it`, {
          evidence: ev,
        }),
      ];
    }
    if (a.authorizationError && /ALTNAME|Hostname|IP/i.test(a.authorizationError)) {
      return [dead(ctx, 'tls', 'stale', 0.4, `TLS certificate does not cover ${host} (${a.authorizationError})`, { evidence: ev })];
    }
    if (a.authorizationError === 'SELF_SIGNED_CERT_IN_CHAIN' || a.authorizationError === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
      return [dead(ctx, 'tls', 'stale', 0.3, `self-signed TLS certificate (${a.authorizationError})`, { evidence: ev })];
    }
    return [alive(ctx, 'tls', 0.2, `valid TLS certificate, ${left} days left (issuer ${a.issuer ?? '?'})`, { evidence: ev })];
  },
};
