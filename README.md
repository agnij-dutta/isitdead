# isitdead

Is this company or project actually alive? Give it a domain, a GitHub org, an X handle, an npm package or a name, and it answers **ALIVE / DORMANT / DEAD / UNKNOWN** with a confidence, a short "why" list, and the evidence and timestamp behind every signal. For job seekers, investors and anyone doing diligence on a company or a dependency.

```
$ isitdead atom.io --name Atom --github atom --x AtomEditor
Atom (atom.io, github:atom, @AtomEditor)  DEAD  confidence 84%

Why:
  - content: page is a shutdown notice: "Sunsetting Atom - The GitHub Blog" [confirmed serially, 1 attempt(s)]
  - github: all 100+ public repos are archived (read-only): explicitly end-of-life [confirmed serially, 1 attempt(s)]
  - x-activity: last tweet 7.2 years ago (2019-07-23) [confirmed serially, 1 attempt(s)]
  - http: no site of its own: atom.io redirects to github.blog [confirmed serially, 1 attempt(s)]
  + tls: valid TLS certificate, 83 days left (issuer Sectigo Limited)
  + x-profile: @AtomEditor exists (58783 followers), bio has no staleness markers
```

Real output, captured 2026-10-04 (full run with every signal and source in [`examples/atom.txt`](examples/atom.txt), JSON evidence in [`examples/atom.json`](examples/atom.json)).

## Why

Directory pages, Crunchbase profiles and old press keep saying "live" long after a company is gone, so isitdead checks things that are hard to fake: is the domain parked or suspended, does the homepage still name the company, when was original code last pushed, is anyone hiring.

The harder problem is the checker lying to you. Public APIs rate-limit under concurrency, and some answer a rate limit with something that looks exactly like "user not found". A bulk sweep then reports live accounts as dead. isitdead is built around one rule: **an error is never an absence**. Errors become `unknown`, and every negative from the fast parallel pass is re-checked one at a time, with backoff, bypassing the cache, before it is allowed to count.

## Quickstart

Requires Node 22 or newer. No API keys.

```bash
git clone https://github.com/agnij-dutta/isitdead.git
cd isitdead
npm ci
npm test
npm run build

node dist/cli.js stripe.com --github stripe --x stripe   # one real check (network)
node dist/cli.js demo-flaky                              # offline, simulated rate-limit trap
```

To get an `isitdead` command on your PATH, run `npm link` after building. The examples below use `isitdead`; `node dist/cli.js` works the same.

## Usage

```bash
isitdead stripe.com --github stripe --x stripe
isitdead github.com/atom
isitdead npm:request --github request
isitdead "Acme Advisory AG" --domain example.com   # the name is matched on the homepage
isitdead theranos.com --x theranos --wayback --json

isitdead batch examples/companies.csv --out results.json
isitdead serve --port 8787     # tiny local web page on 127.0.0.1
isitdead demo-flaky            # offline simulation of the false-negative trap
```

### Targets

| input                                                       | parsed as          |
| ----------------------------------------------------------- | ------------------ |
| `stripe.com`, `https://stripe.com/x`                        | domain             |
| `github.com/stripe`, `github:stripe`                        | GitHub user or org |
| `@stripe`, `x.com/stripe`, `twitter.com/stripe`, `x:stripe` | X handle           |
| `npm:left-pad`, `npmjs.com/package/left-pad`                | npm package        |
| anything else, e.g. `"Acme Advisory AG"`                    | entity name        |

When no name is given, one is derived from the domain or handle (`stripe.com` becomes `stripe`) and marked as derived.

### Commands and flags

| command / flag                 | meaning                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `isitdead <target>`            | check one target                                                   |
| `isitdead batch <file.csv>`    | check many: parallel discovery, serial confirmation                |
| `isitdead serve`               | local web page and `GET /api/check?q=...` JSON endpoint            |
| `isitdead demo-flaky`          | offline replay of the rate-limit false-negative trap (simulated)   |
| `--name <n>`                   | entity name to look for on the homepage (default: derived)         |
| `--domain <d>`                 | website domain                                                     |
| `--github <org>`               | GitHub org or user                                                 |
| `--x <handle>`                 | X handle (company accounts)                                        |
| `--npm <pkg>`                  | npm package, scoped names work                                     |
| `--ats <slug>`                 | Greenhouse/Ashby/Lever board slug (default: guessed from the name) |
| `--wayback`                    | also query the Wayback Machine for the last content change         |
| `--json`                       | machine-readable output                                            |
| `--out <file>`                 | also write the JSON to a file                                      |
| `--no-cache`                   | do not read the on-disk cache (responses are still written)        |
| `--no-confirm`                 | skip serial re-confirmation; for comparison only                   |
| `--concurrency <n>`            | batch discovery concurrency, default 6                             |
| `--port <n>`                   | port for `serve`, default 8787                                     |
| `-h, --help` / `-v, --version` | help / version                                                     |

**Exit codes** for a single check: `0` ALIVE, `2` DORMANT, `3` DEAD, `4` UNKNOWN, `1` usage or runtime error. `batch`, `serve` and `demo-flaky` exit 0 on success.

**CSV** for `batch`: a header row with any of `input,name,domain,github,x,npm,ats` (`twitter` is accepted for `x`). Lines starting with `#` are skipped. A file with a single headerless column is treated as free-form inputs. See [`examples/companies.csv`](examples/companies.csv).

### Environment variables

| variable             | default             | meaning                |
| -------------------- | ------------------- | ---------------------- |
| `ISITDEAD_CACHE_DIR` | `~/.cache/isitdead` | on-disk cache location |
| `NO_COLOR`           | unset               | disable ANSI colors    |

No keys or tokens are read. See [`.env.example`](.env.example).

### Library API

```ts
import { check, batch, buildTarget, HttpClient, FileCache } from 'isitdead';

const http = new HttpClient({ cache: new FileCache() });
const { report, stats, discoveryVerdict } = await check(buildTarget('stripe.com', { github: 'stripe' }), { http });
console.log(report.verdict); // { verdict, confidence, why, scores }
```

| export                                                                                   | what it is                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `check(target, deps, options?)`                                                          | one target, discovery then confirmation. Returns `{ report, stats, discoveryVerdict }` |
| `batch(targets, deps, options?)`                                                         | many targets; `options.concurrency`, `options.onProgress`                              |
| `discover`, `confirm`                                                                    | the two phases, separately                                                             |
| `buildTarget(input, flags?)`, `parseInput`, `targetsFromCsv`                             | input parsing                                                                          |
| `decide(signals)`                                                                        | the verdict function                                                                   |
| `HttpClient`, `classifyApi`, `FileCache`, `MemoryCache`, `HostLimiter`                   | the polite HTTP layer                                                                  |
| `alive`, `dead`, `errored`, `inconclusive`, `fromApiError`, `Probe`, `Ctx`, `ALL_PROBES` | the signal plugin interface                                                            |

`deps` is `{ http, dns?, tls?, now?, sleep?, probes?, backoffMs?, maxRetryAfterMs? }`; everything but `http` has a real default. All types (`Report`, `SignalResult`, `Verdict`, ...) are exported.

## How it works

```
 target ──► Discovery (parallel)                    Confirmation (serial)              Verdict
            ┌──────────────────────────┐            ┌─────────────────────────────┐    ┌──────────────┐
            │ dns  web  tls  github    │  dead or   │ re-run the probe, one at a  │    │ sum weights: │
            │ npm  x    jobs [wayback] │──errored──►│ time, backoff 1s/3s/8s,     │───►│ alive / gone │
            │ all probes concurrently  │  signals   │ honour Retry-After, no cache│    │ / stale      │
            └──────────────────────────┘            └─────────────────────────────┘    └──────────────┘
                       │                                        │
                       └── per-host limiter, 6 h cache, ────────┘
                           identifying user-agent, timeouts
```

**Three states per signal.** Every signal is exactly one of:

| state     | meaning                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alive`   | an endpoint answered cleanly and the answer says alive                                                                                                                 |
| `dead`    | an endpoint answered cleanly and the answer says gone (`kind: gone`) or abandoned (`kind: stale`)                                                                      |
| `unknown` | the check **errored** (rate limit, quota 403, 5xx, timeout, unexpected redirect, unreadable body) or was **inconclusive** (no ATS board found, JS-only page, bot wall) |

Only a clean 404/410, or an equivalent authoritative answer (NXDOMAIN, a deprecation flag, an archived flag), is treated as absence. `classifyApi()` in `src/http.ts` is the single place that maps HTTP answers to found / absent / error. A crashing probe becomes `unknown(error)` under each signal it owns.

**Discovery** runs every applicable probe for a target concurrently, and in batch mode several targets at once (`--concurrency`, default 6). **Confirmation** then re-runs every probe that produced a `dead` or errored signal, serially, up to three times, sleeping 1 s, 3 s and 8 s (or the server's `Retry-After`, capped at 30 s), and bypassing cache reads:

- still negative: `confirmed`
- now alive: `flipped-alive`
- keeps erroring: `unconfirmed`, downgraded to `unknown(error)`. It is never reported as dead.
- errored signal gets a clean answer: `recovered`; signals that were skipped because their parent check failed (hosting and content when the homepage fetch errored) are filled in: `refreshed`.

**Verdict** (`src/verdict.ts`) sums signal weights into `alive`, `gone` and `stale` scores. Unknown signals add nothing and each error lowers confidence by 10%.

- **DEAD**: strong "gone" evidence (suspended, parked or expired host, shutdown notice, all repos archived, deprecated package, NXDOMAIN) outweighs alive evidence
- **DORMANT**: exists but abandoned (no original commits in a year, all-fork GitHub, stale bio, years since last tweet)
- **ALIVE**: recent original commits, open roles, recent tweets, a homepage that names the company
- **UNKNOWN**: less than 0.3 total weight of clean evidence either way

Confidence is `(0.55 × margin + 0.45 × coverage) × error penalty`, clamped to 10% to 97%. The full rules are in the doc comment on `decide()`.

### Signals

| signal       | source (all keyless)                                 | what it catches                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dns`        | system resolver (A, AAAA, CNAME)                     | NXDOMAIN, no records. SERVFAIL and timeouts are `unknown`                                                                                                                                                 |
| `http`       | `GET https://<domain>/`, redirects followed manually | status, full redirect chain, the domain now redirecting to another site, refused on both 443 and 80                                                                                                       |
| `hosting`    | homepage body and headers                            | HTTP 402 non-payment pages (not paywalls), Vercel paused/disabled, Netlify/Render/Heroku/GitHub Pages/Shopify/Firebase/Fly/cPanel suspended or missing, DNS-host expiry pages, parked or for-sale domains |
| `content`    | homepage body                                        | the page no longer names the entity (the domain sells something else now); shutdown notices in the title, og:title or h1                                                                                  |
| `tls`        | TLS handshake on :443                                | expired, mismatched or self-signed certificates                                                                                                                                                           |
| `github`     | `api.github.com/users/<org>/repos?sort=pushed`       | last push to an **original** repo, forks vs originals, archived repos                                                                                                                                     |
| `npm`        | `registry.npmjs.org/<pkg>`                           | deprecated latest version, last registry update                                                                                                                                                           |
| `x-profile`  | `api.fxtwitter.com/2/profile/<handle>`               | account gone, stale bio ("formerly", "we've moved", "acquired by")                                                                                                                                        |
| `x-activity` | `api.fxtwitter.com/2/profile/<handle>/statuses`      | last tweet date                                                                                                                                                                                           |
| `jobs`       | Greenhouse, Ashby, Lever public board APIs           | open roles (strong alive signal). No board is **not** evidence of death                                                                                                                                   |
| `wayback`    | Wayback CDX (opt-in, `--wayback`)                    | last capture with changed content                                                                                                                                                                         |

FxTwitter's v1 endpoint answers an unknown handle with a `302` to the FxEmbed GitHub repo. That is a redirect, not a not-found, so isitdead uses the v2 endpoint, which returns a clean JSON 404. A test locks this in.

### Politeness

- **User-agent**: `isitdead/0.1.0 (liveness checker; polite, cached; +https://github.com/agnij-dutta/isitdead)`. It never pretends to be a browser.
- **Per-host limits**, shared across every target in a run: GitHub 2 in flight and 500 ms between starts, FxTwitter 2 and 400 ms, Wayback 1 and 1 s, npm 4 and 100 ms, everything else 4 and 150 ms (`src/limiter.ts`).
- **Cache**: on disk, 6 hour TTL. Only clean answers (2xx, 404, 410) are cached, so a cached entry is never a rate limit. Confirmation always bypasses cache reads.
- **Timeouts**: 15 s per HTTP request (per redirect hop, at most 10 hops), 30 s for Wayback, 5 s per DNS query with 2 tries, 8 s TLS handshake. Bodies are capped at 5 MB; a truncated JSON body is an error, never a "zero" (job boards count postings as a lower bound instead).

## Results

### Real batch run: 0 of 13 negatives flipped

[`examples/batch.txt`](examples/batch.txt) and [`examples/batch.json`](examples/batch.json) are a real run over the 13 public companies and projects in [`examples/companies.csv`](examples/companies.csv), five picked as obviously alive and eight with well-documented ends. Run on 2026-10-04 on the author's Mac (Apple Silicon, macOS, Node 22) over a residential connection, concurrency 6.

```
Error vs absence report
  Discovery: 13 targets at concurrency 6, 115 network requests (cache hits excluded)
  Negatives in the parallel pass: 13
    confirmed dead on serial re-check:   13
    flipped to alive on serial re-check:  0
    downgraded to unknown (re-check errored): 0
  Parallel-pass false-negative rate: 0% of negatives did not survive confirmation
  Errored signals retried: 3 (0 recovered, 3 still erroring, none counted as dead)
  Verdicts changed by confirmation: 0 (0 would have been wrongly reported DEAD)
```

At this size, with the per-host limits on, the parallel pass produced no false negatives: every negative survived serial confirmation. That is the expected result when the limiter does its job. Confirmation is insurance for when it does not (bigger batches, shared IPs, an API changing its rate limits).

Verdicts: Stripe, Linear, Vercel, Supabase and Palantir ALIVE; Atom, request, Theranos, Sidewalk Labs and Rdio DEAD; Quibi DORMANT (its X bio says it moved); `fast.co` UNKNOWN (not enough clean evidence); Juicero ALIVE, which is wrong (see limitations).

### Simulated: the rate-limit trap (`demo-flaky`)

`isitdead demo-flaky` runs entirely offline against a **simulated** profile API that answers "User not found" whenever more than 2 requests are in flight. 20 made-up accounts, 5 truly gone, swept at concurrency 6 with the per-host limiter disabled. The numbers below are from that simulation, not from real accounts:

```
Error vs absence report
  Discovery: 20 targets at concurrency 6, 55 network requests (cache hits excluded)
  Negatives in the parallel pass: 20
    confirmed dead on serial re-check:   5
    flipped to alive on serial re-check:  15
    downgraded to unknown (re-check errored): 0
  Parallel-pass false-negative rate: 75% of negatives did not survive confirmation
  Errored signals retried: 0 (0 recovered, 0 still erroring, none counted as dead)
  Verdicts changed by confirmation: 15 (15 would have been wrongly reported DEAD)

All numbers above come from the in-process simulation, not from real accounts.
```

It models a real failure mode (a bio sweep where the API's rate-limit answer looked like "user not found"). The 75% figure (15 of 20) follows directly from the simulation's parameters; it is **not** a measured false-negative rate of any real API, and the real batch above saw 0%. Full output: [`examples/demo-flaky.txt`](examples/demo-flaky.txt).

## Limitations

What isitdead does **not** prove:

- **Name reuse.** The content check confirms the _name_ is on the page, not the _business_. `juicero.com` reads ALIVE because a sparkling-water brand now uses the Juicero name on the same domain. The press juicer company shut down in 2017. Any domain bought by someone keeping the name will fool it.
- **GitHub keyless quota: 60 requests per hour** per IP. Each target with a GitHub org costs 1 request, plus up to 3 more if its signal is re-checked. A batch with more than roughly 30 to 60 GitHub orgs in an hour will hit the limit. When that happens the GitHub signal reports `unknown (rate limited)`, never dead, and the verdict leans on other signals. Token support is on the roadmap.
- **Guessed job-board slugs.** Without `--ats`, the board slug is guessed from the name. `acme` on Greenhouse may be a different Acme. The summary says when a slug was guessed.
- **Stale-bio heuristics** match phrases like "formerly", "ex-" and "we've moved". A live company whose bio says "formerly known as X" will read as stale.
- **Bot walls and JS-only sites** return 403 or near-empty HTML. Those are `unknown`, so a live site behind Cloudflare contributes nothing.
- **A homepage is not a company.** A site can stay up for years after a company stops operating, and a company can be alive with a dead site. That is why several independent signals are combined.
- **FxTwitter** is a third-party proxy, not the X API. If it changes its response format or goes down, X signals become `unknown`.
- **One serial re-check** decides a negative. A source that is wrong consistently, not just under load, will still be wrong.

## Ethics

- **Public data only.** Every source is a public, keyless endpoint: DNS, the target's own homepage, public GitHub/npm metadata, public job boards, public X profiles via FxTwitter, the Wayback Machine.
- **Polite by default.** Identifying user-agent, per-host concurrency and spacing, a cache, and backoff that honours `Retry-After`. Please do not raise the limits to sweep faster.
- **Companies and projects, not people.** It is built to answer "is this company or project alive?". Do not use it to track, profile or harass individuals, or to pressure maintainers about their projects. Examples and tests use only public company accounts or made-up handles.

## Prior art

- [isitmaintained.com](https://isitmaintained.com/) measures GitHub issue response times. isitdead asks a different question (does the entity still exist) and combines many sources beyond GitHub.
- [OpenSSF Scorecard](https://github.com/ossf/scorecard) includes a "Maintained" check for repos. isitdead covers companies and websites, not only code.
- Uptime checkers ([downforeveryoneorjustme.com](https://downforeveryoneorjustme.com/) and similar) say whether a site responds. A parked or suspended site responds with HTTP 200; isitdead reads what the page says.
- Company databases (Crunchbase, LinkedIn) report a status field someone has to update. isitdead reads primary evidence and shows it.

What isitdead adds: the three-state signal model, serial re-confirmation of every negative, and a fingerprint set for host suspension, parking and shutdown pages.

## Roadmap

- Optional `GITHUB_TOKEN` to lift the 60/hour GitHub quota (still working keyless by default)
- Registrable-domain detection via the Public Suffix List instead of the current heuristic
- Company-identity check for name reuse (does the page match the company's other signals, not just its name)
- More sources: PyPI, crates.io, app stores, company registries where a keyless API exists
- More job boards (Workable, SmartRecruiters, Recruitee)
- An overall per-target deadline in addition to per-request timeouts

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), including how to add a signal in about 50 lines. Security reports: [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)

## Author

Agnij Dutta · [@0xholmesdev](https://x.com/0xholmesdev) · [github.com/agnij-dutta](https://github.com/agnij-dutta)
