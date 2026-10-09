# Troubleshooting

**Why doesn't `fetch` throw on 404/500?** Native Fetch only rejects on network failure. steadyfetch throws `HttpError` for status ≥ 400 by default; with `throwHttpErrors: false` you get the `Response` back. The attempt's body is left unread on `error.response` — consume or cancel it.

**Why wasn't my request retried?** Retries are off unless `retry.maxAttempts > 1`. Then check, in order: method in `retry.methods`? status in `statusCodes` (4xx never by default)? timeouts need `retryOnTimeout: true`; `Retry-After` larger than `maxRetryAfterMs`; delay budget; `totalTimeout` too short; the request was aborted; the body wasn't replayable. The terminal error's `code`/`reason` tells you which.

**Why isn't my POST retried?** By design. Add `methods: ["POST"]` only if the server de-duplicates with an idempotency key it enforces.

**`BODY_NOT_REPLAYABLE`** — you passed a `ReadableStream` (single-use). Pass `() => makeStream()` instead.

**CORS errors in browsers** appear as `NETWORK_ERROR` with no detail (the browser hides it). Check the console, the server's `Access-Control-Allow-*` headers, and preflight handling. steadyfetch cannot bypass CORS.

**Timeout vs cancellation** — `TimeoutError` (`phase`: `attempt`, `total`, `queue`) vs `AbortError` (`reason`: `caller`, `client-closed`). Only `attempt` timeouts can be retried.

**Timeouts don't stop a slow body** — they end when headers arrive. Pass `signal: AbortSignal.timeout(ms)` to bound the whole download.

**Why do retries increase latency?** Worst case ≈ `maxAttempts × timeout + Σ delays`. Bound it with `totalTimeout`.

**`ORIGIN_NOT_ALLOWED` for a redirect** — the server redirected to another origin. Add it to `allowedOrigins` or use `redirect: "error"`.

**`fetch` is undefined** — pass `fetch` in options (Node ≥ 20 and browsers have it).

**Requests hang with `concurrency`** — permits are held until response headers. A server that never sends headers holds a slot until `timeout`; keep `timeout` finite.
