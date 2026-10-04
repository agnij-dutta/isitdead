import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, type EngineDeps } from './engine.js';
import { buildTarget } from './target.js';

/**
 * Tiny local web page: one form, one JSON endpoint (`GET /api/check?q=...`).
 * Binds to 127.0.0.1 only. Checks run one at a time so the page cannot be
 * used to fan out requests faster than the CLI would.
 */
export function serve(deps: EngineDeps, port: number) {
  const here = dirname(fileURLToPath(import.meta.url));
  const page = join(here, '..', 'web', 'index.html');
  let queue: Promise<unknown> = Promise.resolve();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname === '/') {
      try {
        const body = await readFile(page, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`could not read ${page}: ${(e as Error).message}`);
      }
      return;
    }
    if (url.pathname === '/api/check') {
      const q = url.searchParams;
      const input = q.get('q') ?? '';
      if (!input && !q.get('domain') && !q.get('github') && !q.get('x') && !q.get('npm')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'q is required' }));
        return;
      }
      const target = buildTarget(input, {
        name: q.get('name') ?? undefined,
        domain: q.get('domain') ?? undefined,
        github: q.get('github') ?? undefined,
        x: q.get('x') ?? undefined,
        npm: q.get('npm') ?? undefined,
        ats: q.get('ats') ?? undefined,
      });
      const job = queue.then(() => check(target, deps, { wayback: q.get('wayback') === '1' }));
      queue = job.catch(() => {});
      try {
        const r = await job;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...r.report, confirmation: r.stats, discoveryVerdict: r.discoveryVerdict.verdict }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1', () => console.log(`isitdead web: http://localhost:${port}`));
  return server;
}
