import { MemoryCache } from './cache.js';
import { batch, type BatchResult } from './engine.js';
import { HttpClient } from './http.js';
import { HostLimiter } from './limiter.js';
import { xProbe } from './signals/x.js';
import { buildTarget } from './target.js';

/**
 * Offline reproduction of the bio-sweep incident: a profile API that answers
 * "User not found" whenever it is hit by more than two requests at once.
 * Under a 6-way fan-out, live accounts come back as "not found". Serial
 * re-confirmation with backoff catches every one of them.
 *
 * No network: the API is simulated in-process.
 */
export async function flakyDemo(opts: { accounts?: number; reallyDead?: number; concurrency?: number } = {}): Promise<BatchResult> {
  const total = opts.accounts ?? 20;
  const deadCount = opts.reallyDead ?? 5;
  const handles = Array.from({ length: total }, (_, i) => `account${String(i + 1).padStart(2, '0')}`);
  const reallyDead = new Set(handles.slice(total - deadCount));
  let inflight = 0;
  const now = new Date('2026-10-04T00:00:00Z');

  const fakeFetch = async (url: string): Promise<Response> => {
    inflight++;
    try {
      await new Promise((r) => setTimeout(r, 25));
      const m = url.match(/\/2\/profile\/([^/?]+)(\/statuses)?/);
      const h = m?.[1] ?? '';
      const overloaded = inflight > 2;
      if (overloaded || reallyDead.has(h)) {
        // The trap: overload looks exactly like a missing account.
        return Response.json({ code: 404, message: 'User not found' }, { status: 404 });
      }
      if (m?.[2]) {
        return Response.json({ code: 200, results: [{ created_timestamp: Math.floor(now.getTime() / 1000) - 3 * 86400 }] });
      }
      return Response.json({ code: 200, user: { screen_name: h, description: 'building things', followers: 100, statuses: 10 } });
    } finally {
      inflight--;
    }
  };

  const http = new HttpClient({
    fetch: fakeFetch as never,
    cache: new MemoryCache(),
    // The naive sweep: no per-host politeness.
    limiter: new HostLimiter(() => ({ maxConcurrent: 100, minGapMs: 0 })),
  });
  const targets = handles.map((h) => buildTarget(`@${h}`));
  return batch(targets, { http, probes: [xProbe], now: () => now, backoffMs: [50, 150, 400] }, { concurrency: opts.concurrency ?? 6 });
}
