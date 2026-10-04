# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability reporting: on the repository page, open **Security**, then **Report a vulnerability**. Do not open a public issue.

You should get a response within 7 days. Please include steps to reproduce and the version (`isitdead -v`).

## Scope

isitdead holds no secrets and needs no API keys. It fetches public URLs derived from user input and parses the responses. In scope:

- Anything that makes isitdead send requests to hosts other than the target's own domain and the documented public APIs (for example, URL or host injection through target parsing).
- The local web server (`isitdead serve`): it binds to 127.0.0.1 only. Issues that expose it to other machines, or script injection through page content shown in the web UI, are in scope.
- Cache poisoning: making a rate-limit or error response get cached as a clean answer.
- Crashes or unbounded resource use triggered by a hostile web page or API response (oversized bodies, redirect loops, pathological regex input).

## Non-goals

- isitdead does not verify the identity behind a domain or account. A verdict is an aggregation of public signals, not proof, and can be wrong (see Limitations in the README).
- Following a redirect from a target's homepage to any host is expected behavior: that is how the redirect chain is recorded.
- Rate limiting by third-party services is expected and is reported as `unknown`.

## Responsible use

isitdead is for checking whether companies and projects are alive, using public data and polite request rates. Using it to track or harass individuals is outside its purpose and not supported.
