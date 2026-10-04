import type { CheckOptions, Ctx, Probe } from './context.js';
import { errored } from './context.js';
import { HttpClient, VERSION } from './http.js';
import { defaultSleep } from './limiter.js';
import { ALL_PROBES } from './signals/index.js';
import { systemDns, type DnsResolver } from './signals/dns.js';
import { systemTls, type TlsProber } from './signals/tls.js';
import type { Report, SignalResult, Target, Verdict } from './types.js';
import { decide } from './verdict.js';

/**
 * Injected dependencies. Only `http` is required; everything else defaults
 * to the real system implementation. Tests swap these for fakes.
 */
export interface EngineDeps {
  http: HttpClient;
  /** Default: Node's resolver (A, AAAA, CNAME), 5 s timeout, 2 tries. */
  dns?: DnsResolver;
  /** Default: a TLS handshake on :443 with an 8 s idle timeout. */
  tls?: TlsProber;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Default: ALL_PROBES. */
  probes?: Probe[];
  /** Backoff before each serial re-check attempt, in ms. Length = max attempts. Default [1000, 3000, 8000]. */
  backoffMs?: number[];
  /** Upper bound on honoring Retry-After during confirmation. Default 30 s. */
  maxRetryAfterMs?: number;
}

export interface RunOptions extends CheckOptions {
  /** Skip serial re-confirmation (not recommended; for comparison only). */
  noConfirm?: boolean;
}

export interface ConfirmStats {
  /** Dead signals found in the parallel discovery pass. */
  negatives: number;
  confirmed: number;
  flippedAlive: number;
  /** Dead in discovery, could not be re-checked cleanly: downgraded to unknown. */
  unconfirmed: number;
  /** Errored signals in discovery. */
  errors: number;
  recovered: number;
  stillError: number;
  attempts: number;
}

export const emptyStats = (): ConfirmStats => ({
  negatives: 0,
  confirmed: 0,
  flippedAlive: 0,
  unconfirmed: 0,
  errors: 0,
  recovered: 0,
  stillError: 0,
  attempts: 0,
});

interface ProbeRun {
  probe: Probe;
  results: SignalResult[];
}

export interface Discovery {
  target: Target;
  runs: ProbeRun[];
  startedAt: string;
}

function ctxFor(deps: EngineDeps, options: CheckOptions, fresh: boolean): Ctx {
  return {
    http: deps.http,
    dns: deps.dns ?? systemDns,
    tls: deps.tls ?? systemTls,
    now: deps.now ?? (() => new Date()),
    fresh,
    options,
  };
}

async function runProbe(probe: Probe, target: Target, ctx: Ctx): Promise<SignalResult[]> {
  try {
    return await probe.run(target, ctx);
  } catch (e) {
    // A crashing probe is an error, never a negative. Report it under every
    // signal the probe owns so confirmation can match the retry to it.
    const msg = `${probe.id} check crashed: ${(e as Error).message} (not counted as dead)`;
    return probe.signals.map((name) => errored(ctx, name, msg));
  }
}

/** Phase 1: fan out. All applicable probes for one target run concurrently. */
export async function discover(target: Target, deps: EngineDeps, options: RunOptions = {}): Promise<Discovery> {
  const ctx = ctxFor(deps, options, false);
  const startedAt = ctx.now().toISOString();
  const probes = (deps.probes ?? ALL_PROBES).filter((p) => p.applies(target, options));
  const runs = await Promise.all(probes.map(async (probe) => ({ probe, results: await runProbe(probe, target, ctx) })));
  return { target, runs, startedAt };
}

const isError = (s: SignalResult) => s.state === 'unknown' && s.unknownReason === 'error';

/**
 * Phase 2: confirm every negative serially, with backoff, bypassing the cache.
 *
 * For each probe that produced a dead or errored signal, the whole probe is
 * re-run (one target at a time, one probe at a time) up to `backoff.length`
 * times. Before each attempt we sleep for the backoff step, or for the
 * server's Retry-After when that is longer (capped at `maxRetryAfterMs`).
 *
 * Outcomes per signal:
 *   dead  -> alive          : flipped-alive (the parallel pass was wrong)
 *   dead  -> dead           : confirmed
 *   dead  -> unknown/error  : unconfirmed, downgraded to unknown(error)
 *   error -> clean answer   : recovered
 *   error -> error          : still-error
 *   inconclusive -> clean   : refreshed (a sibling signal that was skipped
 *                             because its parent check failed, e.g. hosting
 *                             and content when the homepage fetch errored)
 *
 * An error is never reported as "dead". A negative that first appears in
 * this phase (recovered or refreshed) came from a serial, cache-bypassing
 * request, which is the same standard a confirmed negative meets.
 */
export async function confirm(d: Discovery, deps: EngineDeps, options: RunOptions, stats: ConfirmStats): Promise<SignalResult[]> {
  const ctx = ctxFor(deps, options, true);
  const sleep = deps.sleep ?? defaultSleep;
  const backoff = deps.backoffMs ?? [1000, 3000, 8000];
  const maxRetryAfter = deps.maxRetryAfterMs ?? 30_000;
  const out: SignalResult[] = [];

  for (const run of d.runs) {
    const pending = new Map<string, SignalResult>();
    for (const s of run.results) {
      if (s.state === 'dead') {
        stats.negatives++;
        pending.set(s.signal, s);
      } else if (isError(s)) {
        stats.errors++;
        pending.set(s.signal, s);
      }
    }
    if (!pending.size) {
      out.push(...run.results);
      continue;
    }

    const resolved = new Map<string, { r: SignalResult; attempts: number }>();
    const lastError = new Map<string, SignalResult>();
    let extra: SignalResult[] = [];
    let lastFresh: SignalResult[] = [];
    let attempts = 0;
    let retryAfterMs = 0;
    for (const wait of backoff) {
      await sleep(Math.max(wait, Math.min(retryAfterMs, maxRetryAfter)));
      attempts++;
      stats.attempts++;
      const fresh = await runProbe(run.probe, d.target, ctx);
      lastFresh = fresh;
      retryAfterMs = 0;
      for (const [name] of pending) {
        if (resolved.has(name)) continue;
        const nr = fresh.find((x) => x.signal === name);
        if (!nr) continue;
        if (isError(nr)) {
          lastError.set(name, nr);
          const ra = Number((nr.evidence as { retryAfterSec?: number }).retryAfterSec);
          if (Number.isFinite(ra)) retryAfterMs = Math.max(retryAfterMs, ra * 1000);
        } else {
          resolved.set(name, { r: nr, attempts });
        }
      }
      // Signals that only appear once a parent check succeeds (e.g. x-activity after x-profile).
      const known = new Set(run.results.map((x) => x.signal));
      extra = fresh.filter((x) => !known.has(x.signal) && !isError(x));
      if ([...pending.keys()].every((k) => resolved.has(k))) break;
    }

    for (const orig of run.results) {
      const p = pending.get(orig.signal);
      const base = { attempts, originalState: orig.state, originalSummary: orig.summary };
      if (!p) {
        const refreshed = orig.state === 'unknown' ? lastFresh.find((x) => x.signal === orig.signal) : undefined;
        if (refreshed && !isError(refreshed) && (refreshed.state !== 'unknown' || refreshed.summary !== orig.summary)) {
          out.push({ ...refreshed, confirmation: { ...base, outcome: 'refreshed' } });
        } else {
          out.push(orig);
        }
        continue;
      }
      const res = resolved.get(orig.signal);
      if (orig.state === 'dead') {
        if (res && res.r.state === 'alive') {
          stats.flippedAlive++;
          out.push({ ...res.r, confirmation: { ...base, attempts: res.attempts, outcome: 'flipped-alive' } });
        } else if (res && res.r.state === 'dead') {
          stats.confirmed++;
          out.push({ ...res.r, confirmation: { ...base, attempts: res.attempts, outcome: 'confirmed' } });
        } else {
          stats.unconfirmed++;
          const why = res ? res.r.summary : (lastError.get(orig.signal)?.summary ?? 'signal not produced on re-check');
          out.push({
            ...errored(ctx, orig.signal, `negative could not be re-confirmed (${why}); parallel pass said: ${orig.summary}`, {
              source: orig.source,
              evidence: { original: orig.evidence, recheck: res?.r.evidence ?? lastError.get(orig.signal)?.evidence },
            }),
            confirmation: { ...base, outcome: 'unconfirmed' },
          });
        }
      } else {
        if (res) {
          stats.recovered++;
          out.push({ ...res.r, confirmation: { ...base, attempts: res.attempts, outcome: 'recovered' } });
        } else {
          stats.stillError++;
          out.push({ ...(lastError.get(orig.signal) ?? orig), confirmation: { ...base, outcome: 'still-error' } });
        }
      }
    }
    out.push(...extra);
  }
  return out;
}

function report(d: Discovery, signals: SignalResult[], deps: EngineDeps): Report {
  return {
    target: d.target,
    verdict: decide(signals),
    signals,
    startedAt: d.startedAt,
    finishedAt: (deps.now ?? (() => new Date()))().toISOString(),
    tool: { name: 'isitdead', version: VERSION },
  };
}

export interface CheckResult {
  report: Report;
  stats: ConfirmStats;
  /** What the verdict would have been without serial re-confirmation. */
  discoveryVerdict: Verdict;
}

/** Check one target: parallel discovery, then serial confirmation of every negative and error. */
export async function check(target: Target, deps: EngineDeps, options: RunOptions = {}): Promise<CheckResult> {
  const d = await discover(target, deps, options);
  const discoverySignals = d.runs.flatMap((r) => r.results);
  const stats = emptyStats();
  const signals = options.noConfirm ? discoverySignals : await confirm(d, deps, options, stats);
  return { report: report(d, signals, deps), stats, discoveryVerdict: decide(discoverySignals) };
}

export interface BatchResult {
  results: CheckResult[];
  stats: ConfirmStats;
  concurrency: number;
  requests: number;
  /** Targets whose verdict was DEAD in the parallel pass but not after confirmation. */
  verdictsRescued: number;
  /** Targets whose verdict changed at all after confirmation. */
  verdictsChanged: number;
}

/**
 * Batch: discovery fans out across targets with bounded concurrency, then
 * every negative from every target is re-checked one at a time.
 */
export async function batch(
  targets: Target[],
  deps: EngineDeps,
  options: RunOptions & { concurrency?: number; onProgress?: (msg: string) => void } = {},
): Promise<BatchResult> {
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const discoveries: Discovery[] = new Array(targets.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (next < targets.length) {
      const i = next++;
      discoveries[i] = await discover(targets[i]!, deps, options);
      options.onProgress?.(`discovered ${i + 1}/${targets.length}: ${targets[i]!.input}`);
    }
  });
  await Promise.all(workers);

  const stats = emptyStats();
  const results: CheckResult[] = [];
  for (const d of discoveries) {
    const discoverySignals = d.runs.flatMap((r) => r.results);
    const before = { ...stats };
    const signals = options.noConfirm ? discoverySignals : await confirm(d, deps, options, stats);
    const per: ConfirmStats = Object.fromEntries(
      Object.entries(stats).map(([k, v]) => [k, v - (before as Record<string, number>)[k]!]),
    ) as unknown as ConfirmStats;
    if (per.negatives || per.errors)
      options.onProgress?.(`confirmed ${d.target.input}: ${per.negatives} negative(s), ${per.flippedAlive} flipped`);
    results.push({ report: report(d, signals, deps), stats: per, discoveryVerdict: decide(discoverySignals) });
  }
  const verdictsChanged = results.filter((r) => r.discoveryVerdict.verdict !== r.report.verdict.verdict).length;
  const verdictsRescued = results.filter((r) => r.discoveryVerdict.verdict === 'DEAD' && r.report.verdict.verdict !== 'DEAD').length;
  return { results, stats, concurrency, requests: deps.http.requests, verdictsRescued, verdictsChanged };
}
