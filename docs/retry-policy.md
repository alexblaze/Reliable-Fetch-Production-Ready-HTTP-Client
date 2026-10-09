# Retry policy

## Attempt counting

`maxAttempts` is the **total number of network attempts including the first request**. `maxAttempts: 3` means one request plus up to two retries. `1` (the default) disables retries. A hard ceiling of 20 prevents accidental retry storms.

## What is retried

A failed attempt is retried only if **all** of these hold:

1. **Eligible** — the method is in `methods` (default `GET`, `HEAD`, `OPTIONS`) **and** the failure is a status in `statusCodes` (default 408, 429, 500, 502, 503, 504), a network error (`retryOnNetworkError`, default on), or an attempt timeout (`retryOnTimeout`, default off). 4xx statuses such as 400/401/403/404/422 are never retried by default. `shouldRetry(info)` _replaces_ this step if provided (a throwing `shouldRetry` means "don't retry" and is reported to `onHookError`).
2. **Attempts left** — fewer than `maxAttempts` attempts have run.
3. **Retry-After acceptable** — for 429/503 a valid `Retry-After` (delta-seconds or HTTP-date) larger than `maxRetryAfterMs` (30 s) stops retrying; it is never clamped to something shorter than the server asked, and never sleeps unbounded. Invalid values are ignored.
4. **Budget** — cumulative sleep ≤ `maxTotalDelayMs` (60 s).
5. **Deadline** — the delay must end before `totalTimeout` expires.
6. **Replayable body** — see below.

Caller cancellation, `close()` and total-deadline expiry are never retried. If an _eligible_ failure stops at step 2–5 you get `RetryExhaustedError` (`reason` = `max-attempts` / `retry-after-too-long` / `budget` / `deadline`); stopping at step 6 gives `BodyNotReplayableError`. With `throwHttpErrors: false`, an exhausted _status_ failure returns the last response instead.

When the final failure was **not eligible** (e.g. 404 after a 503), that error/response is surfaced directly. When retries are disabled, the original `HttpError`/`NetworkError`/`TimeoutError` is thrown.

## Methods and idempotency

HTTP method names don't prove server-side safety. The defaults are the methods HTTP defines as safe. `PUT` and `DELETE` are idempotent by HTTP semantics but your API may differ, so they require opting in. POST/PATCH retries require listing them _and_ should use a server-enforced idempotency key; a client-generated key alone guarantees nothing.

## Body replayability

Strings, `URLSearchParams`, `ArrayBuffer`, typed arrays, `Blob`, `FormData` and `json:` bodies are replayable. A raw `ReadableStream` is not: the retry is refused. Pass a **function** returning a new body instead — it is called once per attempt (`duplex: "half"` is added for streams).

## Backoff and jitter

`delay = min(maxDelayMs, baseDelayMs × 2^retryIndex)` (`retryIndex` 0 for the first retry; `backoff: "fixed"` uses `baseDelayMs`). With `jitter: true` (default) the delay is uniform in `[delay/2, delay]` ("equal jitter") so clients de-synchronize but keep a minimum wait. For 429/503 the wait is `max(backoff, Retry-After)`. Exponents are clamped, so the arithmetic cannot overflow.

## Concurrency, rate limits and retries

The concurrency permit is released **before** the retry sleep. Each retry re-queues for a permit and a rate-limit slot, so every network attempt counts toward `rateLimit`. Retried responses' bodies are cancelled.

## Cancellation and deadlines

- `signal` aborts everything: queue waits, attempts, sleeps → `AbortError`.
- `timeout` bounds each attempt (to headers); `queueTimeout` bounds each wait for capacity; `totalTimeout` bounds the whole operation.
- If a retry delay would reach the total deadline, steadyfetch stops with `RetryExhaustedError(reason: "deadline")` instead of sleeping uselessly.
