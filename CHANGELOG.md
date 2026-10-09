# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/); before 1.0.0 the API may change in minor releases.

## [0.1.0] - Unreleased

### Added

- `createSteadyFetch` client on top of the standard Fetch API (`fetch`, verb helpers, strict `json<T>()`, `extend`, `close`).
- Per-attempt, queue and total timeouts; caller cancellation that is distinguishable from timeouts; leak-free cleanup.
- Conservative retry engine: `maxAttempts` (counts the first request), exponential/fixed backoff with jitter, `Retry-After` (seconds and HTTP-date), delay budget, body replayability checks, body factories.
- FIFO concurrency limiter and sliding-window rate limiter with bounded, cancellation-aware queues.
- Typed error hierarchy with stable error codes and redacted metadata.
- Redacted lifecycle events, URL sanitization, origin allow-list, http(s)-only and no-credentials URL policy.
- ESM + CJS builds with type declarations; zero runtime dependencies.

### Deferred

- Request deduplication, circuit breaker, token refresh, caching, per-origin limits, priorities.
