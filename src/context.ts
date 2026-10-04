import { HttpClient, type ApiOutcome } from './http.js';
import type { DeadKind, SignalName, SignalResult, Target } from './types.js';
import type { DnsResolver } from './signals/dns.js';
import type { TlsProber } from './signals/tls.js';

export interface CheckOptions {
  /** Run the optional Wayback Machine check. */
  wayback?: boolean;
}

export interface Ctx {
  http: HttpClient;
  dns: DnsResolver;
  tls: TlsProber;
  now: () => Date;
  /** True during serial re-confirmation: bypass cache reads. */
  fresh: boolean;
  options: CheckOptions;
}

/**
 * A probe performs one logical check and may emit several signals
 * (for example one homepage fetch yields http, hosting and content).
 * Probes must be re-runnable: the confirmation phase calls run() again.
 */
export interface Probe {
  id: string;
  applies(target: Target, options: CheckOptions): boolean;
  run(target: Target, ctx: Ctx): Promise<SignalResult[]>;
}

type Base = { evidence?: Record<string, unknown>; source?: string };

export function alive(ctx: Ctx, signal: SignalName, weight: number, summary: string, b: Base = {}): SignalResult {
  return { signal, state: 'alive', weight, summary, evidence: b.evidence ?? {}, source: b.source, checkedAt: ctx.now().toISOString() };
}

export function dead(ctx: Ctx, signal: SignalName, kind: DeadKind, weight: number, summary: string, b: Base = {}): SignalResult {
  return { signal, state: 'dead', kind, weight, summary, evidence: b.evidence ?? {}, source: b.source, checkedAt: ctx.now().toISOString() };
}

export function errored(ctx: Ctx, signal: SignalName, summary: string, b: Base = {}): SignalResult {
  return {
    signal,
    state: 'unknown',
    unknownReason: 'error',
    weight: 0,
    summary,
    evidence: b.evidence ?? {},
    source: b.source,
    checkedAt: ctx.now().toISOString(),
  };
}

export function inconclusive(ctx: Ctx, signal: SignalName, summary: string, b: Base = {}): SignalResult {
  return {
    signal,
    state: 'unknown',
    unknownReason: 'inconclusive',
    weight: 0,
    summary,
    evidence: b.evidence ?? {},
    source: b.source,
    checkedAt: ctx.now().toISOString(),
  };
}

export function fromApiError(
  ctx: Ctx,
  signal: SignalName,
  what: string,
  o: Extract<ApiOutcome, { kind: 'error' }>,
  source: string,
): SignalResult {
  return errored(ctx, signal, `${what}: ${o.reason} (not counted as dead)`, {
    source,
    evidence: { status: o.status, error: o.reason, retryAfterSec: o.retryAfterSec },
  });
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

export function humanAge(days: number): string {
  if (days < 1) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30.4)} months ago`;
  return `${(days / 365.25).toFixed(1)} years ago`;
}
