import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated?: boolean;
  url: string;
  storedAt: number;
}

/**
 * Response cache. Only clean answers (2xx, 404, 410) are stored, so a cached
 * entry can never be a rate limit or a server error.
 */
export interface Cache {
  get(key: string): Promise<CachedResponse | undefined>;
  set(key: string, value: CachedResponse): Promise<void>;
}

/** In-process cache, used by tests and the offline demo. */
export class MemoryCache implements Cache {
  private m = new Map<string, CachedResponse>();
  constructor(
    private ttlMs = 6 * 3600_000,
    private clock: () => number = Date.now,
  ) {}
  async get(key: string) {
    const v = this.m.get(key);
    if (!v) return undefined;
    if (this.clock() - v.storedAt > this.ttlMs) return undefined;
    return v;
  }
  async set(key: string, value: CachedResponse) {
    this.m.set(key, value);
  }
}

/**
 * Tiny on-disk cache so re-runs do not hammer public APIs. One JSON file per
 * request, keyed by a hash of method, URL and request headers. Default TTL
 * 6 hours; location `$ISITDEAD_CACHE_DIR` or `~/.cache/isitdead`. Failures
 * to read or write are ignored: the cache is an optimisation, never a source
 * of truth.
 */
export class FileCache implements Cache {
  constructor(
    private dir = process.env.ISITDEAD_CACHE_DIR ?? join(homedir(), '.cache', 'isitdead'),
    private ttlMs = 6 * 3600_000,
  ) {}
  private path(key: string) {
    return join(this.dir, createHash('sha256').update(key).digest('hex').slice(0, 32) + '.json');
  }
  async get(key: string) {
    try {
      const v = JSON.parse(await readFile(this.path(key), 'utf8')) as CachedResponse;
      if (Date.now() - v.storedAt > this.ttlMs) return undefined;
      return v;
    } catch {
      return undefined;
    }
  }
  async set(key: string, value: CachedResponse) {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.path(key), JSON.stringify(value));
    } catch {
      /* cache is best effort */
    }
  }
}
