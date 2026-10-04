import { Resolver } from 'node:dns/promises';
import { alive, dead, errored, type Probe } from '../context.js';

export type DnsAnswer =
  | { ok: true; addresses: string[]; cname?: string[] }
  | { ok: false; code: string; message: string };

export type DnsResolver = (host: string) => Promise<DnsAnswer>;

/** Codes that mean "the authoritative answer is: no such name / no records". */
const ABSENT_CODES = new Set(['ENOTFOUND', 'ENODATA']);

export const systemDns: DnsResolver = async (host) => {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  const tryType = async (fn: () => Promise<string[]>) => {
    try {
      return { ok: true as const, v: await fn() };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      return { ok: false as const, code: err.code ?? 'EDNS', message: err.message };
    }
  };
  const a = await tryType(() => r.resolve4(host));
  if (a.ok && a.v.length) return { ok: true, addresses: a.v };
  const aaaa = await tryType(() => r.resolve6(host));
  if (aaaa.ok && aaaa.v.length) return { ok: true, addresses: aaaa.v };
  const cname = await tryType(() => r.resolveCname(host));
  if (cname.ok && cname.v.length) return { ok: true, addresses: [], cname: cname.v };
  // Prefer reporting a real error over an absence if any lookup errored.
  const failures = [a, aaaa, cname].filter((x) => !x.ok) as Array<{ ok: false; code: string; message: string }>;
  const hardError = failures.find((f) => !ABSENT_CODES.has(f.code));
  const pick = hardError ?? failures[0] ?? { code: 'ENODATA', message: 'no records' };
  return { ok: false, code: pick.code, message: pick.message };
};

export const dnsProbe: Probe = {
  id: 'dns',
  applies: (t) => !!t.domain,
  async run(t, ctx) {
    const host = t.domain!;
    const ans = await ctx.dns(host);
    if (ans.ok) {
      const what = ans.addresses.length ? ans.addresses.slice(0, 3).join(', ') : `CNAME ${ans.cname?.join(', ')}`;
      return [alive(ctx, 'dns', 0.1, `${host} resolves (${what})`, { evidence: { ...ans } })];
    }
    if (ans.code === 'ENOTFOUND') {
      return [dead(ctx, 'dns', 'gone', 1.0, `${host} does not exist in DNS (NXDOMAIN)`, { evidence: { code: ans.code } })];
    }
    if (ans.code === 'ENODATA') {
      return [dead(ctx, 'dns', 'gone', 0.7, `${host} exists but has no A/AAAA/CNAME records`, { evidence: { code: ans.code } })];
    }
    return [errored(ctx, 'dns', `DNS lookup for ${host} failed: ${ans.code} (not counted as dead)`, { evidence: { code: ans.code, message: ans.message } })];
  },
};
