/**
 * Library entry point. The CLI (`src/cli.ts`) is a thin wrapper over these.
 *
 *   import { check, buildTarget, HttpClient, FileCache } from 'isitdead';
 *   const http = new HttpClient({ cache: new FileCache() });
 *   const { report } = await check(buildTarget('stripe.com'), { http });
 */
export * from './types.js';
export {
  check,
  batch,
  discover,
  confirm,
  type EngineDeps,
  type RunOptions,
  type CheckResult,
  type BatchResult,
  type ConfirmStats,
  type Discovery,
} from './engine.js';
export { HttpClient, classifyApi, safeJson, USER_AGENT, VERSION, type ApiOutcome, type FetchLike, type HttpResult } from './http.js';
export { FileCache, MemoryCache, type Cache, type CachedResponse } from './cache.js';
export { HostLimiter, HOST_POLICIES, DEFAULT_POLICY, type HostPolicy } from './limiter.js';
export { buildTarget, parseInput, describeTarget } from './target.js';
export { targetsFromCsv } from './csv.js';
export { decide } from './verdict.js';
// Extension point: everything needed to write a probe outside this repo.
export { alive, dead, errored, inconclusive, fromApiError, type Probe, type Ctx, type CheckOptions } from './context.js';
export { ALL_PROBES } from './signals/index.js';
export type { DnsResolver, DnsAnswer } from './signals/dns.js';
export type { TlsProber, TlsAnswer } from './signals/tls.js';
