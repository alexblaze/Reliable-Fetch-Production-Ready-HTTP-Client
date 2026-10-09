# Decisions (ADR summary)

1. **Name.** The spec's working name `reliable-fetch` is already published on npm (verified with `npm view`), so the package is **`steadyfetch`** (E404 at time of writing, 2026-10). Re-check npm, GitHub and trademarks before publishing.
2. **Build tool: tsup.** One config yields ESM + CJS + `.d.ts`/`.d.cts`, deterministic, dev-only.
3. **Module formats.** ESM and CJS are both shipped and exercised by `scripts/smoke-consumer.mjs`.
4. **Return type.** Native `Response` for verbs (no hidden metadata, streaming works); `json<T>()` returns `{ data, response }`. Raw JSON helper is the only parsing convenience.
5. **Retries off by default**, attempts count the first request, POST/PATCH never by default.
6. **Timeout scope.** Timers end when response headers arrive; body reads are bounded by the caller's signal. Cheaper and clearer than wrapping body streams.
7. **Lock order.** Concurrency permit → rate-limit slot, so requests start the moment they are granted; permits are released before retry sleeps.
8. **Redirects.** The runtime follows them; steadyfetch only detects violations afterwards and says so.
9. **Deferred** until core semantics settle: deduplication (needs subscriber-cancellation design), circuit breaker, token refresh, caching, per-origin limits, priorities, proxy management, generic middleware chain (a single `beforeAttempt` hook covers header signing).
10. **License: MIT** (already in the repository).
11. **No `Request` input.** A `Request` body is single-use so it cannot be replayed safely.
12. **Single-file error module** rather than one file per class: the classes are tiny and share helpers.
