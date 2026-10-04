/**
 * Per-host politeness: caps in-flight requests per host and enforces a
 * minimum gap between request starts to the same host.
 */
export interface HostPolicy {
  maxConcurrent: number;
  minGapMs: number;
}

export const DEFAULT_POLICY: HostPolicy = { maxConcurrent: 4, minGapMs: 150 };

/** Hosts known to be stingy get a gentler default. */
export const HOST_POLICIES: Record<string, HostPolicy> = {
  'api.github.com': { maxConcurrent: 2, minGapMs: 500 },
  'api.fxtwitter.com': { maxConcurrent: 2, minGapMs: 400 },
  'web.archive.org': { maxConcurrent: 1, minGapMs: 1000 },
  'registry.npmjs.org': { maxConcurrent: 4, minGapMs: 100 },
};

interface HostState {
  active: number;
  lastStart: number;
  waiters: Array<() => void>;
}

export class HostLimiter {
  private hosts = new Map<string, HostState>();
  constructor(
    private policyFor: (host: string) => HostPolicy = (h) => HOST_POLICIES[h] ?? DEFAULT_POLICY,
    private sleep: (ms: number) => Promise<void> = defaultSleep,
    private clock: () => number = Date.now,
  ) {}

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(host);
    try {
      return await fn();
    } finally {
      this.release(host);
    }
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = { active: 0, lastStart: 0, waiters: [] };
      this.hosts.set(host, s);
    }
    return s;
  }

  private async acquire(host: string): Promise<void> {
    const policy = this.policyFor(host);
    const s = this.state(host);
    while (s.active >= policy.maxConcurrent) {
      await new Promise<void>((resolve) => s.waiters.push(resolve));
    }
    s.active++;
    const wait = s.lastStart + policy.minGapMs - this.clock();
    s.lastStart = Math.max(this.clock(), s.lastStart + policy.minGapMs);
    if (wait > 0) await this.sleep(wait);
  }

  private release(host: string): void {
    const s = this.state(host);
    s.active--;
    const next = s.waiters.shift();
    if (next) next();
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
