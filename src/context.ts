import { HttpClient, type ApiOutcome } from './http.js';
import type { DeadKind, SignalName, SignalResult, Target } from './types.js';
import type { DnsResolver } from './signals/dns.js';
import type { TlsProber } from './signals/tls.js';

/** Per-run options that change which probes apply. */
export interface CheckOptions {
  /** Run the optional Wayback Machine check. */
  wayback?: boolean;
}

/**
 * Everything a probe may touch. Probes never call `fetch`, DNS or TLS
 * directly: going through the context is what gives them politeness
 * (per-host limits), caching, the identifying user-agent, timeouts, and
 * mockability in tests.
 */
export interface Ctx {
  /** Rate-limited, cached HTTP client. Pass `{ fresh: ctx.fresh }` on every request. */
  http: HttpClient;
  dns: DnsResolver;
  tls: TlsProber;
  /** Use this instead of `new Date()` so ages are testable. */
  now: () => Date;
  /** True during serial re-confirmation: bypass cache reads. */
  fresh: boolean;
  options: CheckOptions;
}

/**
 * The extension point. A probe performs one logical check and may emit
 * several signals (one homepage fetch yields http, hosting and content).
 *
 * Contract (see CONTRIBUTING.md, "Adding a signal"):
 *
 * - Return a result for every name in `signals` whenever you can, even if it
 *   is `inconclusive(...)`. A missing result is treated as "not produced".
 * - Only return `dead(...)` when an endpoint answered cleanly and the answer
 *   is negative (a 404/410, NXDOMAIN, a deprecation flag). Anything that
 *   failed (429, 5xx, quota 403, timeout, unexpected redirect, unparseable or
 *   truncated body) must be `errored(...)`. Use `classifyApi()` for JSON APIs.
 * - Absence of evidence is `inconclusive(...)`, not `dead(...)`.
 * - Probes must be re-runnable and side-effect free: the confirmation phase
 *   calls `run()` again with `ctx.fresh = true` for any dead or errored signal.
 * - Throwing is allowed but discouraged; the engine turns a throw into an
 *   `errored` result for each declared signal.
 */
export interface Probe {
  /** Short stable id, used in logs. */
  id: string;
  /** Every signal name this probe can emit. Used to report crashes per signal. */
  signals: readonly SignalName[];
  /** Cheap, synchronous: does this target carry the inputs this probe needs? */
  applies(target: Target, options: CheckOptions): boolean;
  run(target: Target, ctx: Ctx): Promise<SignalResult[]>;
}

/** Optional extras for the result constructors below. */
type Base = {
  /** Raw facts behind the summary. Shown in `--json` output. */
  evidence?: Record<string, unknown>;
  /** The endpoint that was queried. */
  source?: string;
};

/** Positive evidence of life. `weight` is 0..1, see verdict.ts for scale. */
export function alive(ctx: Ctx, signal: SignalName, weight: number, summary: string, b: Base = {}): SignalResult {
  return { signal, state: 'alive', weight, summary, evidence: b.evidence ?? {}, source: b.source, checkedAt: ctx.now().toISOString() };
}

/**
 * Clean negative evidence. `kind: 'gone'` = it no longer exists;
 * `kind: 'stale'` = it exists but is abandoned. Only for clean answers.
 */
export function dead(ctx: Ctx, signal: SignalName, kind: DeadKind, weight: number, summary: string, b: Base = {}): SignalResult {
  return { signal, state: 'dead', kind, weight, summary, evidence: b.evidence ?? {}, source: b.source, checkedAt: ctx.now().toISOString() };
}

/** The check failed. Weight is always 0 and the signal is retried during confirmation. */
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

/** The check worked but proved nothing (no ATS board, JS-only page). Weight 0, not retried. */
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

/** Wrap a `classifyApi` error as an errored signal, keeping Retry-After for the confirmation backoff. */
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

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

/** "3 days ago", "5 months ago", "2.1 years ago". */
export function humanAge(days: number): string {
  if (days < 1) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30.4)} months ago`;
  return `${(days / 365.25).toFixed(1)} years ago`;
}
