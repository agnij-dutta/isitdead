#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { FileCache } from './cache.js';
import { targetsFromCsv } from './csv.js';
import { flakyDemo } from './demo.js';
import { batch, check, type EngineDeps } from './engine.js';
import { formatBatch, formatCheck } from './format.js';
import { HttpClient, VERSION } from './http.js';
import { serve } from './server.js';
import { buildTarget } from './target.js';

const HELP = `isitdead ${VERSION}: is this company or project actually alive?

Usage:
  isitdead <target> [flags]           check one target
  isitdead batch <file.csv> [flags]   check many (parallel discovery, serial confirmation)
  isitdead serve [--port 8787]        tiny local web page
  isitdead demo-flaky                 offline replay of the rate-limit false-negative trap

Target: a domain (stripe.com), github.com/org or github:org, @handle or x.com/handle,
npm:package, or a plain name ("Acme Advisory AG").

Flags:
  --name <n>       entity name to look for on the homepage (default: from domain)
  --domain <d>     website domain
  --github <org>   GitHub org or user
  --x <handle>     X handle
  --npm <pkg>      npm package
  --ats <slug>     Greenhouse/Ashby/Lever board slug (default: guessed from name)
  --wayback        also check the Wayback Machine for last content change
  --json           machine-readable output
  --out <file>     also write JSON to a file
  --no-cache       do not read the on-disk cache (~/.cache/isitdead)
  --no-confirm     skip serial re-confirmation of negatives (for comparison only)
  --concurrency N  batch discovery concurrency (default 6)

CSV columns (header row): input,name,domain,github,x,npm,ats

Every signal is alive, dead, or unknown. Errors (rate limits, 5xx, timeouts)
are unknown, never dead. Every negative is re-checked serially with backoff.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      domain: { type: 'string' },
      github: { type: 'string' },
      x: { type: 'string' },
      npm: { type: 'string' },
      ats: { type: 'string' },
      wayback: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      'no-confirm': { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.version) return console.log(VERSION);
  const [cmd, arg] = positionals;
  const hasFlagTarget = values.domain || values.github || values.x || values.npm || values.name;
  if (values.help || (!cmd && !hasFlagTarget)) return console.log(HELP);

  const http = new HttpClient({ cache: values['no-cache'] ? undefined : new FileCache() });
  const deps: EngineDeps = { http };
  const options = { wayback: values.wayback, noConfirm: values['no-confirm'] };

  if (cmd === 'demo-flaky') {
    const b = await flakyDemo();
    console.log('Simulated profile API that answers "User not found" when more than 2 requests are in flight.');
    console.log('20 accounts, 5 truly gone, swept at concurrency 6.\n');
    console.log(values.json ? JSON.stringify(b, null, 2) : formatBatch(b));
    return;
  }

  if (cmd === 'serve') {
    serve(deps, Number(values.port ?? 8787));
    return;
  }

  if (cmd === 'batch') {
    if (!arg) throw new Error('batch needs a CSV file');
    const targets = targetsFromCsv(await readFile(arg, 'utf8'));
    if (!targets.length) throw new Error(`no targets in ${arg}`);
    const b = await batch(targets, deps, {
      ...options,
      concurrency: values.concurrency ? Number(values.concurrency) : 6,
      onProgress: (m) => process.stderr.write(`  ${m}\n`),
    });
    const json = JSON.stringify(
      {
        tool: { name: 'isitdead', version: VERSION },
        ranAt: new Date().toISOString(),
        concurrency: b.concurrency,
        requests: b.requests,
        confirmation: b.stats,
        verdictsChanged: b.verdictsChanged,
        verdictsRescued: b.verdictsRescued,
        results: b.results.map((r) => ({ ...r.report, confirmation: r.stats, discoveryVerdict: r.discoveryVerdict.verdict })),
      },
      null,
      2,
    );
    if (values.out) await writeFile(values.out, json + '\n');
    console.log(values.json ? json : formatBatch(b));
    return;
  }

  const target = buildTarget(cmd ?? '', {
    name: values.name,
    domain: values.domain,
    github: values.github,
    x: values.x,
    npm: values.npm,
    ats: values.ats,
  });
  const r = await check(target, deps, options);
  const json = JSON.stringify({ ...r.report, confirmation: r.stats, discoveryVerdict: r.discoveryVerdict.verdict }, null, 2);
  if (values.out) await writeFile(values.out, json + '\n');
  console.log(values.json ? json : formatCheck(r));
  process.exitCode = { ALIVE: 0, DORMANT: 2, DEAD: 3, UNKNOWN: 4 }[r.report.verdict.verdict];
}

main().catch((e) => {
  console.error(`isitdead: ${(e as Error).message}`);
  process.exitCode = 1;
});
