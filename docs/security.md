# Security

Threat model summary: steadyfetch protects _callers_ from common client-side failure modes (secret leakage in logs, unbounded retries/queues, URL confusion). It is not an SSRF firewall, an authorization layer, or a TLS stack.

## Secret redaction

- Events and errors contain no headers, no request/response bodies, and no raw URLs.
- `sanitizeUrl` removes `user:pass@` and the fragment and replaces values of sensitive query parameters with `[REDACTED]`. Names are compared case-insensitively ignoring `-`, `_`, `.`; exact matches include `token`, `key`, `password`, `secret`, `session`, `sid`, `email`, `auth`, `code`, `sig`, `jwt`, `apikey`, and any name containing `token`, `secret`, `password`, `apikey`, `authoriz`, `credential`, `signature`. Add names with `redact.queryParams` or redact every value with `redact.allQueryValues`.
- Path segments are **not** inspected — don't put secrets in paths.
- `toJSON()` reduces `cause` to `{ name, code }`; arbitrary causes (undici errors) can embed hosts or URLs.
- Exceptions from your own hooks are ignored unless you provide `onHookError`; nothing is written to `console`.
- Redaction is defense in depth. Don't pass secrets to your own logging hooks.

## Destination restrictions

- Only `http:` and `https:`. URLs with embedded credentials are rejected (use headers).
- With a `baseURL`, relative paths are resolved with the URL API and must stay under the base origin _and_ base path (`../`, encoded dot segments, `//host`, `\\host` are rejected or fail the origin check). Absolute URLs are allowed only for the base origin or `allowedOrigins`. Control characters in URLs are rejected because the URL parser would silently strip them.
- The origin policy is re-evaluated on the final URL immediately before **every** attempt.
- Caller-supplied URLs must be validated by _you_: pass untrusted input only as a **path** to a client with a `baseURL`, or use a strict `allowedOrigins` predicate.

### SSRF limitations (read this)

Hostname/origin allow-listing does **not** stop DNS rebinding, requests to private/link-local IPs behind an allowed name, or open redirects. steadyfetch cannot validate redirect hops because the runtime follows them internally. What it does:

- After a redirected response arrives it checks `response.url` against the origin policy and throws `ORIGIN_NOT_ALLOWED` — **the redirected request has already been sent**.
- Use `redirect: "error"` (or `"manual"`) to stop redirects from being followed at all.

For real SSRF defense also use egress filtering, an HTTP(S) proxy/dispatcher that checks resolved IPs, and network policy.

## TLS

The runtime's default verification is used. There is intentionally no `rejectUnauthorized` or similar option. Custom CA/mTLS in Node should be done by injecting a `fetch` built on a configured dispatcher.

## Browsers

CORS, CSP, forbidden headers, cookies and credentials are controlled by the browser. `credentials` is never changed by steadyfetch (default Fetch semantics apply); set it explicitly if needed. Browsers deliberately hide network-error details, so `NETWORK_ERROR` may be a CORS failure. Secrets shipped to a browser are visible to users.

## Retry and resource abuse

Attempts (≤ 20), delay (`maxDelayMs`, `maxRetryAfterMs`, `maxTotalDelayMs`), queue sizes (default 10 000) and `json()` body size (10 MiB) are bounded. Cancelled queue entries are removed in O(1); timers and listeners are removed on every path. Concurrency counts attempts until response headers, not until the body finishes.

## Supply chain

No runtime dependencies, no install scripts, `files` allowlist, tarball verified in CI (`npm run verify:pack`), release via GitHub Actions with npm provenance (OIDC trusted publishing). Dependabot and CodeQL are configured. See [SECURITY.md](../SECURITY.md) for reporting.

## Not covered

Application authorization, input validation, secret management, egress policy, and server-side idempotency are your responsibility. Retry safety depends on server semantics, not method names.
