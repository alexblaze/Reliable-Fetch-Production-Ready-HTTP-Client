# API reference

## `createSteadyFetch(options?) → SteadyFetchClient`

### Client options

| Option             | Type                                   | Default          | Notes                                                                                                                                             |
| ------------------ | -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseURL`          | `string \| URL`                        | —                | Relative paths are joined under its path with the URL API (`/users` and `users` are equal). Requests may not escape the base origin or base path. |
| `allowedOrigins`   | `string[] \| (url: URL) => boolean`    | base origin only | Extends the base origin. Without a `baseURL` and without this option, any http(s) origin is allowed.                                              |
| `headers`          | `HeadersInit`                          | —                | Lowest precedence.                                                                                                                                |
| `timeout`          | `number \| false`                      | `30000`          | Per attempt, until response headers arrive.                                                                                                       |
| `totalTimeout`     | `number`                               | none             | Whole logical request: queueing + attempts + retry delays.                                                                                        |
| `queueTimeout`     | `number`                               | none             | Max wait for a concurrency permit _and_ rate-limit slot, per attempt.                                                                             |
| `retry`            | `RetryOptions \| false`                | disabled         | See [retry-policy.md](retry-policy.md).                                                                                                           |
| `concurrency`      | `{ limit, maxQueueSize? }`             | none             | `maxQueueSize` default 10 000.                                                                                                                    |
| `rateLimit`        | `{ limit, intervalMs, maxQueueSize? }` | none             | Sliding window; burst = `limit`.                                                                                                                  |
| `throwHttpErrors`  | `boolean`                              | `true`           | Throw `HttpError` for status ≥ 400.                                                                                                               |
| `maxResponseBytes` | `number`                               | 10 MiB           | Applies to `json()`.                                                                                                                              |
| `fetch`            | `typeof fetch`                         | global `fetch`   | Injected implementation (never polyfilled).                                                                                                       |
| `onEvent`          | `(event) => void`                      | —                | Redacted lifecycle events.                                                                                                                        |
| `onHookError`      | `(error) => void`                      | ignore           | Receives exceptions from `onEvent` / `retry.shouldRetry`.                                                                                         |
| `beforeAttempt`    | `(ctx) => void \| Promise<void>`       | —                | Runs before **every** network attempt with a per-attempt copy of the headers.                                                                     |
| `redact`           | `{ queryParams?, allQueryValues? }`    | —                | Extra sensitive query names / redact every value.                                                                                                 |
| `requestIdHeader`  | `string`                               | —                | Send the request id in this header.                                                                                                               |

Invalid options throw `ConfigurationError` at construction.

### Methods

- `fetch(input, init?) → Promise<Response>` — `input` is a `string` or `URL` (`Request` objects are not supported because their bodies cannot be replayed).
- `get/head/options/delete(path, options?)`, `post/put/patch(path, body?, options?)` → `Promise<Response>`.
- `json<T>(input, init?) → Promise<{ data: T; response: Response }>`.
- `extend(options) → SteadyFetchClient` — merges headers and retry options, replaces the rest; shares limiters unless `concurrency`/`rateLimit` are given.
- `close()` — aborts queued and in-flight (until headers) requests with `REQUEST_ABORTED`/`client-closed`, rejects new requests.

### Per-request options

Everything in `RequestInit` (except `body`/`headers`/`method` typing) plus: `headers`, `body` (value or **factory**), `json`, `timeout`, `totalTimeout`, `queueTimeout`, `retry`, `throwHttpErrors`, `maxResponseBytes`, `requestId`.

**Precedence:** per-request option > client option > built-in default. Headers: client `headers` < request `headers` < `requestIdHeader` < `beforeAttempt` mutations. `body` and `json` are mutually exclusive; `GET`/`HEAD` can't have a body. `requestId` must match `[A-Za-z0-9._:-]{1,128}`.

### Lifecycle and hook ordering

Per logical request: `request:start` → (per attempt: acquire concurrency permit → acquire rate-limit slot → re-validate origin → `beforeAttempt` → `attempt:start` → fetch → `attempt:end` → on retry `retry:scheduled` and sleep with the permit released) → `request:end` (exactly once, with `outcome`). `request:*` events are per logical request; `attempt:*` and `retry:scheduled` are per attempt. Events are frozen, contain only the sanitized URL, method, ids, counts, durations, status and error code, and exceptions thrown by `onEvent` never affect the request. `beforeAttempt` exceptions **do** fail the request (they're not retried).

### Response-body ownership

You own every returned `Response`. Read it, stream it, or `await response.body?.cancel()`. steadyfetch cancels bodies of responses it discards (retries, redirect violations). A body is never buffered unless you call `json()` (size-limited). `HttpError.response` is unconsumed and non-enumerable.

### Errors

All extend `SteadyFetchError` (`code`, `requestId`, `attempts`, `status`, `url` (sanitized), `cause`, safe `toJSON()`; `toJSON` reduces `cause` to `{ name, code }`). Use `isSteadyFetchError()` across realms/duplicate installs.

| Class                    | Code(s)                                           | Extra                                                                                 |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ConfigurationError`     | `CONFIGURATION_ERROR`, `INVALID_URL`              |                                                                                       |
| `TimeoutError`           | `REQUEST_TIMEOUT`, `QUEUE_TIMEOUT`                | `phase: "attempt" \| "total" \| "queue"`                                              |
| `NetworkError`           | `NETWORK_ERROR`                                   |                                                                                       |
| `HttpError`              | `HTTP_ERROR`                                      | `statusText`, `response`                                                              |
| `ParseError`             | `RESPONSE_PARSE_ERROR`                            | `contentType`                                                                         |
| `AbortError`             | `REQUEST_ABORTED`                                 | `reason: "caller" \| "client-closed"`                                                 |
| `RetryExhaustedError`    | `RETRY_EXHAUSTED`                                 | `reason: "max-attempts" \| "retry-after-too-long" \| "budget" \| "deadline"`, `cause` |
| `BodyNotReplayableError` | `BODY_NOT_REPLAYABLE`                             | `cause` = the failure that would have been retried                                    |
| `OriginNotAllowedError`  | `ORIGIN_NOT_ALLOWED`                              |                                                                                       |
| `QueueFullError`         | `CONCURRENCY_QUEUE_FULL`, `RATE_LIMIT_QUEUE_FULL` | `maxQueueSize`                                                                        |

### Utilities

`sanitizeUrl(url, redactOptions?)` and `parseJsonResponse<T>(response, ctx?)` are exported for use with native responses.
