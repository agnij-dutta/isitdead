# Contributing to isitdead

Thanks for helping. The one rule that matters more than any other here: **an error is never an absence.** A rate limit, a 5xx, a timeout, a redirect or a body you cannot read must never become a `dead` signal. Most review comments on new signals will be about this.

## Setup

Node 22 or newer.

```bash
git clone https://github.com/agnij-dutta/isitdead.git
cd isitdead
npm ci
npm run check    # lint + format check + typecheck (src and tests) + tests
npm run build    # tsc -> dist/
node dist/cli.js demo-flaky
```

| script                            | what it does                                                           |
| --------------------------------- | ---------------------------------------------------------------------- |
| `npm test`                        | vitest. All HTTP, DNS and TLS is mocked; tests never touch the network |
| `npm run lint`                    | ESLint (flat config, typescript-eslint)                                |
| `npm run format` / `format:check` | Prettier                                                               |
| `npm run typecheck`               | `tsc` over `src` and `test`, strict                                    |
| `npm run build`                   | compile to `dist/` with type declarations                              |
| `npm run check`                   | everything CI runs except the build                                    |

## Project layout

```
src/
  cli.ts          argument parsing, output, exit codes
  engine.ts       discovery (parallel) and confirmation (serial) phases, batch
  verdict.ts      weights -> ALIVE / DORMANT / DEAD / UNKNOWN + confidence
  context.ts      the Probe interface, Ctx, and result constructors (alive/dead/errored/inconclusive)
  http.ts         HttpClient (limiter, cache, user-agent, timeouts) and classifyApi()
  limiter.ts      per-host concurrency and spacing
  cache.ts        on-disk and in-memory response caches
  patterns.ts     hosting / parked / suspended page fingerprints, name matching
  target.ts       input parsing (domain, github:, @handle, npm:, name)
  csv.ts          batch CSV parsing
  format.ts       terminal output
  server.ts       local web page
  demo.ts         offline simulated rate-limit demo
  signals/        one file per probe, plus index.ts (the registry)
test/             vitest suites; helpers.ts has the fetch mock and fixtures
examples/         real captured runs (dated) and the batch CSV
web/index.html    the page served by `isitdead serve`
```

## Adding a signal

A signal is produced by a **probe**: an object with an `id`, the `signals` it can emit, an `applies()` test and an async `run()`. Here is a complete probe for PyPI, as a template.

**1. Name the signal** in `src/types.ts`:

```ts
export type SignalName = 'dns' | 'http' /* ... */ | 'pypi';
```

If it needs a new input (here, a PyPI package name), add the field to `Target` and parse it in `src/target.ts` (and `--pypi` in `cli.ts`, `pypi` in `csv.ts`).

**2. Write the probe** in `src/signals/pypi.ts`:

```ts
import { alive, daysBetween, dead, errored, fromApiError, humanAge, inconclusive, type Probe } from '../context.js';
import { classifyApi, safeJson } from '../http.js';

export const pypiProbe: Probe = {
  id: 'pypi',
  signals: ['pypi'],
  applies: (t) => !!t.pypi,
  async run(t, ctx) {
    const url = `https://pypi.org/pypi/${encodeURIComponent(t.pypi!)}/json`;
    // Always go through ctx.http and pass fresh: that is what gives you the
    // limiter, cache, user-agent, timeout, and cache bypass during confirmation.
    const r = await ctx.http.get(url, { fresh: ctx.fresh, headers: { accept: 'application/json' } });
    const o = classifyApi(r);

    // 429, quota 403, 5xx, redirects, network errors: unknown, never dead.
    if (o.kind === 'error') return [fromApiError(ctx, 'pypi', `PyPI lookup for ${t.pypi}`, o, url)];
    // Only a clean 404/410 is absence.
    if (o.kind === 'absent') return [dead(ctx, 'pypi', 'gone', 0.8, `no PyPI project "${t.pypi}" (clean 404)`, { source: url })];

    const doc = r.ok ? safeJson<{ urls?: Array<{ upload_time_iso_8601?: string }> }>(r.body) : undefined;
    // A 200 you cannot read is a failed check: use errored(), so it gets retried.
    if (!doc) return [errored(ctx, 'pypi', 'PyPI returned an unreadable body (not counted as dead)', { source: url })];
    const uploaded = doc.urls?.[0]?.upload_time_iso_8601;
    // Worked, but proves nothing: inconclusive, weight 0.
    if (!uploaded) return [inconclusive(ctx, 'pypi', 'no files on the latest release', { source: url })];

    const days = daysBetween(new Date(uploaded), ctx.now());
    const line = `latest release uploaded ${humanAge(days)}`;
    const evidence = { uploaded, days };
    if (days <= 365) return [alive(ctx, 'pypi', 0.6, line, { source: url, evidence })];
    return [dead(ctx, 'pypi', 'stale', 0.5, line, { source: url, evidence })];
  },
};
```

**3. Register it** in `src/signals/index.ts` by appending to `ALL_PROBES`. If the host needs gentler limits, add it to `HOST_POLICIES` in `src/limiter.ts`.

**4. Test it** in `test/`, using `mockFetch` and `ctx` from `test/helpers.ts`. At minimum:

- a live case and a dead case
- a 429 and a 5xx produce `state: 'unknown', unknownReason: 'error'`
- an unexpected redirect and an unreadable 200 body produce `unknownReason: 'error'`
- "nothing found" that is not authoritative (for example, a search with no hits) is `inconclusive`, not `dead`

**5. Document it**: a row in the README signal table, and a CHANGELOG entry.

### The contract, in short

| situation                              | constructor                                               |
| -------------------------------------- | --------------------------------------------------------- |
| clean answer, says alive               | `alive(ctx, name, weight, summary, { source, evidence })` |
| clean answer, says it no longer exists | `dead(ctx, name, 'gone', weight, ...)`                    |
| clean answer, exists but abandoned     | `dead(ctx, name, 'stale', weight, ...)`                   |
| the check failed in any way            | `errored(...)` or `fromApiError(...)`                     |
| the check worked but proves nothing    | `inconclusive(...)`                                       |

- **Weights** are 0..1. Roughly: 1.0 settles the question alone, 0.5 to 0.8 is strong, 0.1 to 0.3 is supporting. Look at the existing probes before picking one; `verdict.ts` documents the scoring.
- **Re-runnable**: confirmation calls `run()` again with `ctx.fresh = true`. No state between runs.
- **Emit every declared signal** when you can (use `inconclusive` for the ones you could not evaluate), so confirmation can match results up.
- **No `new Date()`**: use `ctx.now()` so tests are deterministic.
- **Keyless public endpoints only.** If a source needs a key, open an issue first.

## Other contributions

- **Hosting fingerprints** (a new "site suspended" page): add to `FINGERPRINTS` in `src/patterns.ts` with a test using the real page text. Body regexes run against lowercased HTML.
- **Bug reports** about wrong verdicts: include `--json` output, it has every source URL and timestamp.

## Style

- Prettier and ESLint decide formatting; run `npm run format`.
- Comments explain why, not what. Public functions get a doc comment.
- No em dashes in code, comments or docs.
- Commit messages: plain imperative, e.g. "Add PyPI signal".
