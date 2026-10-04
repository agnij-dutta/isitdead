# isitdead

Is this company or project actually alive? Give it a domain, a GitHub org, an X handle, an npm package or a name, and it answers **ALIVE / DORMANT / DEAD / UNKNOWN** with a confidence, a short "why" list, and the evidence and timestamp behind every signal.

Built for job seekers, investors and anyone doing diligence. Directory pages, Crunchbase and old press keep saying "live" long after a company is gone, so isitdead checks the things that can't fake it.

```
$ isitdead atom.io --name Atom --github atom --x AtomEditor
Atom (atom.io, github:atom, @AtomEditor)  DEAD  confidence 84%

Why:
  - content: page is a shutdown notice: "Sunsetting Atom - The GitHub Blog" [confirmed serially, 1 attempt(s)]
  - github: all 100+ public repos are archived (read-only): explicitly end-of-life [confirmed serially, 1 attempt(s)]
  - x-activity: last tweet 7.2 years ago (2019-07-23) [confirmed serially, 1 attempt(s)]
  - http: no site of its own: atom.io redirects to github.blog [confirmed serially, 1 attempt(s)]
  + tls: valid TLS certificate, 83 days left (issuer Sectigo Limited)
```

## The rule: an error is not an absence

Every signal has exactly three states:

| state     | meaning                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `alive`   | an endpoint answered cleanly and the answer says alive                                                                           |
| `dead`    | an endpoint answered cleanly and the answer says gone (`kind: gone`) or abandoned (`kind: stale`)                                |
| `unknown` | the check **errored** (rate limit, 5xx, timeout, unexpected redirect) or was **inconclusive** (no ATS board found, JS-only page) |

Only a clean 404/410 (or an equivalent authoritative answer like NXDOMAIN) is ever treated as absence. A 429, a GitHub quota 403, a 5xx, a timeout or a redirect is `unknown`, and unknowns never push a verdict toward DEAD.

Then every negative gets a second look:

1. **Discovery** fans out: all probes for a target run concurrently, and in batch mode several targets run at once.
2. **Confirmation** re-checks every `dead` signal (and retries every errored one) **serially, with backoff, bypassing the cache**, honouring `Retry-After`.
   - still negative: `confirmed`
   - now alive: `flipped-alive`
   - keeps erroring: `unconfirmed`, downgraded to `unknown`. It is never reported as dead.

Why: a bio sweep at 6 threads once reported 20 "dead" X accounts. 15 were alive. The API rate-limited under concurrency, and the rate-limit answer looked exactly like "user not found". `isitdead demo-flaky` replays that offline:

```
Negatives in the parallel pass: 20
  confirmed dead on serial re-check:   5
  flipped to alive on serial re-check:  15
Parallel-pass false-negative rate: 75% of negatives did not survive confirmation
Verdicts changed by confirmation: 15 (15 would have been wrongly reported DEAD)
```

## Signals

| signal       | source (all keyless)                            | what it catches                                                                                                                                                                              |
| ------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dns`        | system resolver                                 | NXDOMAIN, no records. SERVFAIL/timeouts are `unknown`                                                                                                                                        |
| `http`       | `GET https://<domain>/`, manual redirects       | status, full redirect chain, domain now redirecting to another site                                                                                                                          |
| `hosting`    | homepage body and headers                       | HTTP 402 non-payment pages (not paywalls), Vercel paused/disabled, Netlify/Render/Heroku/GitHub Pages/Shopify/cPanel suspended or missing, DNS-host expiry pages, parked or for-sale domains |
| `content`    | homepage body                                   | the page no longer mentions the entity (the domain now sells something else); shutdown notices in the title/h1                                                                               |
| `tls`        | TLS handshake on :443                           | expired or mismatched certificates                                                                                                                                                           |
| `github`     | `api.github.com/users/<org>/repos?sort=pushed`  | last push to an **original** repo, forks vs originals, archived repos                                                                                                                        |
| `npm`        | `registry.npmjs.org/<pkg>`                      | deprecated latest version, last registry update                                                                                                                                              |
| `x-profile`  | `api.fxtwitter.com/2/profile/<handle>`          | account gone, stale bio ("ex vp product", "formerly", "we've moved", "acquired by")                                                                                                          |
| `x-activity` | `api.fxtwitter.com/2/profile/<handle>/statuses` | last tweet date                                                                                                                                                                              |
| `jobs`       | Greenhouse, Ashby, Lever public board APIs      | open roles (strong alive signal). No board is **not** evidence of death                                                                                                                      |
| `wayback`    | Wayback CDX (opt-in, `--wayback`)               | last capture with changed content                                                                                                                                                            |

Note on FxTwitter: the v1 endpoint (`api.fxtwitter.com/<handle>`) answers an unknown handle with a `302` to the FxEmbed GitHub repo. That is a redirect, not a not-found, so isitdead uses the v2 endpoint, which returns a clean JSON 404. A test locks this in.

## Verdict

Weights are summed into `alive`, `gone` and `stale` scores (see `src/verdict.ts`):

- **DEAD**: strong "gone" evidence (suspended/parked/expired host, shutdown notice, all repos archived, deprecated package, NXDOMAIN) outweighs alive evidence
- **DORMANT**: exists but abandoned (no original commits in a year, all-fork GitHub, stale bio, years since last tweet)
- **ALIVE**: recent original commits, open roles, recent tweets, homepage that names the company
- **UNKNOWN**: not enough clean evidence either way. Errors lower confidence and never count against the target.

Exit codes: 0 ALIVE, 2 DORMANT, 3 DEAD, 4 UNKNOWN, 1 usage error.

## Usage

Requires Node 22+.

```bash
npm install && npm run build
node dist/cli.js stripe.com --github stripe --x stripe
node dist/cli.js github.com/atom
node dist/cli.js npm:request --github request
node dist/cli.js "Acme Advisory AG" --domain example.com   # name is matched on the homepage
node dist/cli.js theranos.com --x theranos --wayback --json

node dist/cli.js batch examples/companies.csv --out results.json
node dist/cli.js serve --port 8787     # tiny local web page
node dist/cli.js demo-flaky            # offline replay of the false-negative trap
```

Flags: `--name --domain --github --x --npm --ats --wayback --json --out --no-cache --no-confirm --concurrency`.

CSV: header row with any of `input,name,domain,github,x,npm,ats`. Lines starting with `#` are skipped. A single headerless column is treated as free-form inputs.

## Politeness

- Identifying user-agent: `isitdead/<version> (liveness checker; polite, cached; +https://x.com/0xholmesdev)`
- Per-host limits: at most 2 in flight and 500 ms between starts for GitHub, 2 and 400 ms for FxTwitter, 1 and 1 s for the Wayback Machine, 4 and 150 ms elsewhere
- On-disk cache at `~/.cache/isitdead` (6 h TTL, override with `ISITDEAD_CACHE_DIR`). Only clean answers (2xx, 404, 410) are cached. Confirmation always bypasses cache reads.
- GitHub's unauthenticated quota is 60 requests per hour. When it runs out, the GitHub signal reports `unknown (rate limited)`, never dead.

## Examples

`examples/` holds real runs from 2026-10-04: a batch over 13 targets (`batch.txt`, `batch.json`, from `companies.csv`) and single checks with full JSON evidence. Known limitation shown there: `juicero.com` reads ALIVE because a sparkling-water brand now uses the Juicero name on the same domain. The content check confirms the name, not the business.

## Development

```bash
npm test         # vitest, all HTTP mocked
npm run build    # tsc -> dist/
```
