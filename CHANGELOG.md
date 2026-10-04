# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-04

### Added

- CLI and library: `isitdead <target>`, `batch <csv>`, `serve`, `demo-flaky`.
- Three-state signals (alive, dead, unknown) where an error is never counted as dead.
- Two-phase engine: parallel discovery, then serial re-confirmation of every negative and error, with backoff, `Retry-After` and cache bypass.
- Signals: DNS, HTTP and redirect chain, hosting suspension and parked-domain fingerprints, homepage name mentions and shutdown notices, TLS, GitHub activity (originals vs forks, archived), npm (deprecation, last update), X profile and activity via FxTwitter, Greenhouse/Ashby/Lever job boards, Wayback Machine (opt-in).
- Verdicts ALIVE / DORMANT / DEAD / UNKNOWN with confidence and a "why" list; exit codes per verdict.
- Polite HTTP: identifying user-agent, per-host concurrency and spacing, 6 hour on-disk cache of clean answers only, per-request timeouts, 5 MB body cap.
- Offline, simulated rate-limit demo (`demo-flaky`).
- Real captured example runs in `examples/`.
- `Probe.signals`: each probe declares the signals it emits, so a crash is reported under each of them.
- Docs: README, CONTRIBUTING (how to add a signal), SECURITY, CI workflow, issue and PR templates.

### Fixed (during the pre-release review)

- An https connection refused followed by an http timeout was reported as "refuses connections on 443 and 80" (dead). It is now an error.
- An empty job board was reported as a stale signal while another board had errored. It is now an error, and gets retried.
- Job boards larger than the 5 MB body cap (Ashby returns full descriptions) failed as "unparseable". Postings are now counted as a lower bound.
- An unreadable 200 body from GitHub or Wayback was inconclusive and never retried. It is now an error.
- When a homepage fetch recovered during confirmation, the hosting and content signals stayed "skipped". They are now filled in from the re-check.
- `--concurrency` and `--port` with a non-numeric value were silently accepted. They are now usage errors.
