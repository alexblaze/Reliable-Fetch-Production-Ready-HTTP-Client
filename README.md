# steadyfetch

A small, safe HTTP client built on the standard Fetch API: **timeouts, cancellation, conservative retries with backoff and `Retry-After`, concurrency and rate limits, typed errors, and redacted lifecycle events** — with zero runtime dependencies.

> **Status: 0.x (pre-release).** The API may change before 1.0 and changes are listed in the [CHANGELOG](CHANGELOG.md).
> **Name:** the working name `reliable-fetch` is already taken on npm, so this package is `steadyfetch`. Verify availability and ownership before publishing ([docs/decisions.md](docs/decisions.md)).

steadyfetch does **not** guarantee delivery or exactly-once processing — no network client can. It makes failure behaviour explicit and bounded so you can handle it safely.

## Features

| Area          | What you get                                                                                                          | Default                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Timeouts      | per-attempt, queue and total-deadline timeouts, distinguishable from caller cancellation                              | 30 s per attempt                       |
| Retries       | `maxAttempts` (counts the first request), exponential backoff + jitter, `Retry-After` (seconds or date), delay budget | **off** (`maxAttempts: 1`)             |
| Retry safety  | only `GET`/`HEAD`/`OPTIONS`; never non-replayable bodies; POST/PATCH only by explicit opt-in                          | on                                     |
| Concurrency   | FIFO per-client limit, bounded queue, cancellation-aware                                                              | none                                   |
| Rate limiting | N request _starts_ per interval (every retry attempt counts)                                                          | none                                   |
| Errors        | small hierarchy with stable `code`s and redacted metadata                                                             | —                                      |
| Observability | structured events, URL redaction, no outbound telemetry                                                               | none                                   |
| Safety        | origin allow-list, http(s) only, no URL credentials, no path escapes                                                  | base-origin only when `baseURL` is set |
| Parsing       | strict `json<T>()` returning `{ data, response }`, size-limited                                                       | —                                      |

Not included (deliberately deferred): request deduplication, circuit breaker, token refresh, caching, proxy management, priorities. See [docs/decisions.md](docs/decisions.md).

## Install

```sh
npm install steadyfetch
```

**Runtimes:** Node.js ≥ 20 and current evergreen browsers (needs `fetch`, `AbortController`, `URL`). `AbortSignal.any` (Node ≥ 20.3, Chrome 116, Firefox 124, Safari 17.4) is used when available so caller cancellation also stops body streaming; without it, cancellation applies until response headers arrive. There is no fetch polyfill: if `fetch` is missing, pass one via the `fetch` option. ESM and CommonJS are both shipped and tested.

## Quick start

```ts
import { createSteadyFetch } from "steadyfetch";

const api = createSteadyFetch({
  baseURL: "https://api.example.com",
  timeout: 10_000,
  retry: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5_000 }, // GET/HEAD/OPTIONS only
  concurrency: { limit: 5 },
});

const { data, response } = await api.json<{ id: number }[]>("/users"); // typed, metadata preserved
const raw = await api.get("/health"); // native Response
```

### Return values and HTTP errors

`api.get/post/…/fetch` resolve with the **native `Response`**, so streaming works untouched. By default a status ≥ 400 **throws `HttpError`** (set `throwHttpErrors: false` to get the response instead). `error.response` is the unconsumed response — read or cancel its body. `api.json<T>()` strictly parses JSON and returns `{ data, response }`; empty bodies (204), non-JSON content types, malformed JSON and bodies over `maxResponseBytes` (10 MiB) throw `ParseError` without echoing body content.

### Retry safety

```ts
createSteadyFetch({
  retry: {
    maxAttempts: 4, // total attempts INCLUDING the first request
    methods: ["GET", "HEAD", "OPTIONS"], // default; add "PUT"/"DELETE" only if your API is idempotent
    statusCodes: [408, 429, 500, 502, 503, 504], // default
    retryOnNetworkError: true, // default
    retryOnTimeout: false, // default
  },
});
```

- POST/PATCH are never retried unless you list them. If you do, send a server-enforced idempotency key (client-side keys alone guarantee nothing). See [examples/node/post-with-idempotency.ts](examples/node/post-with-idempotency.ts).
- Stream bodies can't be replayed: pass a **body factory** (`() => stream`) or the retry is refused with `BODY_NOT_REPLAYABLE`.
- `Retry-After` is honoured for 429/503 and capped by `maxRetryAfterMs` (30 s); longer values stop retrying instead of sleeping.
- Retries stop at `maxAttempts`, the cumulative `maxTotalDelayMs` budget (60 s), the total deadline, or caller cancellation. Full rules: [docs/retry-policy.md](docs/retry-policy.md).

### Timeouts and cancellation

```ts
const controller = new AbortController();
try {
  await api.get("/slow", { signal: controller.signal, timeout: 5_000, totalTimeout: 20_000 });
} catch (e) {
  // AbortError (REQUEST_ABORTED)  → controller.abort() or api.close()
  // TimeoutError (REQUEST_TIMEOUT) → e.phase is "attempt" | "total";  QUEUE_TIMEOUT → "queue"
}
```

Timeouts cover the time until response headers arrive. To bound body reading, pass your own `signal` (it is wired into `fetch`). Your signal is never mutated, and all timers/listeners are cleaned up on every path.

### Concurrency and rate limiting

```ts
createSteadyFetch({
  concurrency: { limit: 5, maxQueueSize: 1_000 }, // active attempts (until headers); FIFO queue
  rateLimit: { limit: 20, intervalMs: 1_000 }, // ≤ 20 starts per second, burst of 20
  queueTimeout: 5_000, // max wait for capacity per attempt
});
```

A permit is taken first, then a rate-limit slot; the permit is released before any retry sleep. Every network attempt (including retries) counts. Limits are per client and per process; they are not distributed.

### Error handling

```ts
import { HttpError, RetryExhaustedError, isSteadyFetchError } from "steadyfetch";

try {
  await api.get("/x");
} catch (e) {
  if (e instanceof HttpError && e.status === 404) return null;
  if (isSteadyFetchError(e)) log(e.code, e.requestId, e.attempts, e.url); // never the raw URL
  throw e;
}
```

Codes (stable, semver-protected): `CONFIGURATION_ERROR`, `INVALID_URL`, `REQUEST_TIMEOUT`, `QUEUE_TIMEOUT`, `NETWORK_ERROR`, `HTTP_ERROR`, `RESPONSE_PARSE_ERROR`, `REQUEST_ABORTED`, `RETRY_EXHAUSTED`, `BODY_NOT_REPLAYABLE`, `ORIGIN_NOT_ALLOWED`, `RATE_LIMIT_QUEUE_FULL`, `CONCURRENCY_QUEUE_FULL`. Don't branch on message text.

### Security notes

- Secrets never appear in events or errors: no headers or bodies are emitted, URLs are sanitized (credentials and fragment removed, sensitive query values such as `token`, `api_key`, `password`, `email` replaced by `[REDACTED]`).
- With a `baseURL`, requests can't leave its origin (or `allowedOrigins`); only `http:`/`https:` are allowed; URL-embedded credentials and `../` escapes are rejected; the origin is re-checked before every attempt.
- **Limits:** this is not complete SSRF protection. Redirects are followed by the runtime; steadyfetch can only _detect_ a redirect to a disallowed origin after the fact. Use `redirect: "error"` for strict clients, and enforce DNS/IP/egress policy at the network layer. It cannot bypass CORS/CSP, and TLS verification is the runtime default (there is no switch to disable it).

Details: [docs/security.md](docs/security.md) · reporting: [SECURITY.md](SECURITY.md).

## Compared with…

|                           | native `fetch` | steadyfetch        | ky / axios / got                        |
| ------------------------- | -------------- | ------------------ | --------------------------------------- |
| Timeouts, retries, limits | manual         | built in, bounded  | built in (different defaults/semantics) |
| Throws on 4xx/5xx         | no             | yes (configurable) | varies                                  |
| Dependencies              | none           | none               | varies                                  |
| Browser + Node            | yes            | yes                | varies                                  |

steadyfetch is intentionally small. If you need interceptors, cookies jars, proxies or HTTP/2 tuning, use a fuller client.

## Documentation

[API reference](docs/api.md) · [Retry policy](docs/retry-policy.md) · [Security](docs/security.md) · [Troubleshooting](docs/troubleshooting.md) · [Migration](docs/migration.md) · [Decisions](docs/decisions.md)

## Development

```sh
npm ci
npm run lint && npm run typecheck && npm test   # fast checks
npm run build && npm run verify:pack            # tarball allowlist
node scripts/smoke-consumer.mjs                 # install the tarball in a clean project
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Released under the [MIT License](LICENSE).
