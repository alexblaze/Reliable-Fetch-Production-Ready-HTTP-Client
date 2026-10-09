import {
  AbortError,
  BodyNotReplayableError,
  ConfigurationError,
  HttpError,
  NetworkError,
  OriginNotAllowedError,
  QueueFullError,
  RetryExhaustedError,
  SteadyFetchError,
  TimeoutError,
  type ErrorCode,
} from "./errors/errors.js";
import { ConcurrencyLimiter } from "./limits/concurrency.js";
import { RateLimiter } from "./limits/rateLimiter.js";
import { DEFAULT_MAX_RESPONSE_BYTES, parseJsonResponse } from "./response.js";
import {
  DEFAULT_RETRY,
  HARD_MAX_ATTEMPTS,
  decideRetry,
  isDefaultEligible,
  type Failure,
  type ResolvedRetryPolicy,
  type RetryInfo,
  type RetryOptions,
} from "./retry/retryPolicy.js";
import { freezeEvent, type Outcome, type SteadyFetchEvent } from "./telemetry/events.js";
import { sanitizeUrl } from "./telemetry/redact.js";
import type {
  BodySource,
  ClientOptions,
  JsonResult,
  RequestOptions,
  VerbOptions,
} from "./types.js";
import { Scope, WaitAborted, discardBody, sleep, type AbortCause } from "./utils/abort.js";
import { mergeHeaders } from "./utils/headers.js";
import {
  assertOriginAllowed,
  assertSupportedUrl,
  isOriginAllowed,
  parseBaseURL,
  resolveUrl,
} from "./utils/url.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUE = 10_000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const METHOD = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const noop = () => undefined;

let idCounter = 0;
function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `req-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;
}

function validMs(name: string, value: unknown, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    throw new ConfigurationError(`${name} must be a positive finite number of milliseconds`);
  }
  return value;
}

function validCount(name: string, value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ConfigurationError(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

export function resolveRetry(
  client: RetryOptions | false | undefined,
  request: RetryOptions | false | undefined,
): ResolvedRetryPolicy {
  const disabled = request === false || (request === undefined && client === false);
  const merged = disabled
    ? { ...DEFAULT_RETRY, maxAttempts: 1 }
    : { ...DEFAULT_RETRY, ...(client || {}), ...(request || {}) };
  validCount("retry.maxAttempts", merged.maxAttempts, HARD_MAX_ATTEMPTS);
  validMs("retry.baseDelayMs", merged.baseDelayMs, true);
  validMs("retry.maxDelayMs", merged.maxDelayMs, true);
  validMs("retry.maxRetryAfterMs", merged.maxRetryAfterMs, true);
  validMs("retry.maxTotalDelayMs", merged.maxTotalDelayMs, true);
  if (merged.backoff !== "exponential" && merged.backoff !== "fixed") {
    throw new ConfigurationError('retry.backoff must be "exponential" or "fixed"');
  }
  for (const code of merged.statusCodes) {
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new ConfigurationError("retry.statusCodes must contain HTTP status codes");
    }
  }
  return {
    ...merged,
    methods: new Set(merged.methods.map((m) => m.toUpperCase())),
    statusCodes: new Set(merged.statusCodes),
    shouldRetry: merged.shouldRetry,
  };
}

function mergeRetry(
  base: RetryOptions | false | undefined,
  override: RetryOptions | false | undefined,
) {
  if (override === undefined) return base;
  if (override === false || !base) return override;
  return { ...base, ...override };
}

function validQueueSize(name: string, value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_QUEUE;
  if (!Number.isInteger(value) || value < 0)
    throw new ConfigurationError(`${name} must be a non-negative integer`);
  return value;
}

interface Limiters {
  concurrency: ConcurrencyLimiter | undefined;
  rate: RateLimiter | undefined;
}

function buildLimiters(options: ClientOptions): Limiters {
  let concurrency: ConcurrencyLimiter | undefined;
  let rate: RateLimiter | undefined;
  if (options.concurrency) {
    concurrency = new ConcurrencyLimiter(
      validCount("concurrency.limit", options.concurrency.limit),
      validQueueSize("concurrency.maxQueueSize", options.concurrency.maxQueueSize),
    );
  }
  if (options.rateLimit) {
    rate = new RateLimiter(
      validCount("rateLimit.limit", options.rateLimit.limit),
      validMs("rateLimit.intervalMs", options.rateLimit.intervalMs),
      validQueueSize("rateLimit.maxQueueSize", options.rateLimit.maxQueueSize),
    );
  }
  return { concurrency, rate };
}

function isStream(body: unknown): boolean {
  return (
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) ||
    (typeof body === "object" &&
      body !== null &&
      typeof (body as { getReader?: unknown }).getReader === "function")
  );
}

interface Prepared {
  url: URL;
  sanitized: string;
  method: string;
  headers: Headers;
  body: BodySource | undefined;
  replayable: boolean;
  rest: RequestInit;
  requestId: string;
  signal: AbortSignal | undefined;
  timeout: number | undefined;
  totalTimeout: number | undefined;
  queueTimeout: number | undefined;
  retry: ResolvedRetryPolicy;
  throwHttpErrors: boolean;
  maxResponseBytes: number;
}

type AttemptOutcome = { response: Response } | { error: NetworkError | TimeoutError };

export interface RunResult {
  response: Response;
  requestId: string;
  url: string;
  attempts: number;
}

export class SteadyFetchClient {
  readonly #options: ClientOptions;
  readonly #base: URL | undefined;
  readonly #limiters: Limiters;
  readonly #ops = new Set<Scope>();
  #closed = false;

  /** @internal use `createSteadyFetch`. */
  constructor(options: ClientOptions = {}, limiters?: Limiters) {
    this.#options = options;
    this.#base = options.baseURL !== undefined ? parseBaseURL(options.baseURL) : undefined;
    if (options.timeout !== undefined && options.timeout !== false)
      validMs("timeout", options.timeout);
    if (options.totalTimeout !== undefined) validMs("totalTimeout", options.totalTimeout);
    if (options.queueTimeout !== undefined) validMs("queueTimeout", options.queueTimeout);
    if (options.maxResponseBytes !== undefined)
      validCount("maxResponseBytes", options.maxResponseBytes);
    resolveRetry(options.retry, undefined); // validate eagerly
    if (options.requestIdHeader !== undefined) new Headers().set(options.requestIdHeader, "x"); // validates the name
    if (options.headers) new Headers(options.headers);
    this.#limiters = limiters ?? buildLimiters(options);
  }

  // ---- public API -------------------------------------------------------------------------

  /** Performs a request and returns the native `Response`. Its body is yours to consume or cancel. */
  async fetch(input: string | URL, init: RequestOptions = {}): Promise<Response> {
    return (await this.#run(input, init)).response;
  }

  get(path: string | URL, options?: VerbOptions): Promise<Response> {
    return this.fetch(path, { ...options, method: "GET" });
  }
  head(path: string | URL, options?: VerbOptions): Promise<Response> {
    return this.fetch(path, { ...options, method: "HEAD" });
  }
  options(path: string | URL, options?: VerbOptions): Promise<Response> {
    return this.fetch(path, { ...options, method: "OPTIONS" });
  }
  delete(path: string | URL, options?: VerbOptions): Promise<Response> {
    return this.fetch(path, { ...options, method: "DELETE" });
  }
  post(path: string | URL, body?: BodySource, options?: VerbOptions): Promise<Response> {
    return this.fetch(path, {
      ...options,
      method: "POST",
      ...(body !== undefined ? { body } : {}),
    });
  }
  put(path: string | URL, body?: BodySource, options?: VerbOptions): Promise<Response> {
    return this.fetch(path, { ...options, method: "PUT", ...(body !== undefined ? { body } : {}) });
  }
  patch(path: string | URL, body?: BodySource, options?: VerbOptions): Promise<Response> {
    return this.fetch(path, {
      ...options,
      method: "PATCH",
      ...(body !== undefined ? { body } : {}),
    });
  }

  /**
   * Fetches and strictly parses a JSON body, returning the data together with the
   * `Response` (status, headers) so no metadata is hidden. Empty bodies (e.g. 204),
   * non-JSON content types and oversized bodies throw `ParseError`.
   */
  async json<T = unknown>(input: string | URL, init: RequestOptions = {}): Promise<JsonResult<T>> {
    const headers = new Headers(init.headers);
    if (!headers.has("accept") && !new Headers(this.#options.headers).has("accept")) {
      headers.set("accept", "application/json");
    }
    const result = await this.#run(input, { ...init, headers });
    const data = await parseJsonResponse<T>(result.response, {
      requestId: result.requestId,
      attempts: result.attempts,
      url: result.url,
      maxBytes:
        init.maxResponseBytes ?? this.#options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    });
    return { data, response: result.response };
  }

  /**
   * Returns a new client with merged defaults. Headers and retry options are merged,
   * other options replaced. Concurrency/rate limiters are shared unless overridden.
   */
  extend(options: ClientOptions): SteadyFetchClient {
    const merged: ClientOptions = {
      ...this.#options,
      ...options,
      headers: mergeHeaders(this.#options.headers, options.headers),
      retry: mergeRetry(this.#options.retry, options.retry),
    };
    const shareLimiters = options.concurrency === undefined && options.rateLimit === undefined;
    return new SteadyFetchClient(merged, shareLimiters ? this.#limiters : undefined);
  }

  /**
   * Aborts queued and in-flight requests (until their response headers arrive) and
   * rejects future requests. Idempotent.
   */
  close(): void {
    this.#closed = true;
    for (const op of [...this.#ops]) op.abort("client-closed");
  }

  // ---- engine -----------------------------------------------------------------------------

  #prepare(input: string | URL, init: RequestOptions): Prepared {
    const o = this.#options;
    const {
      body,
      json,
      headers,
      signal,
      timeout,
      totalTimeout,
      queueTimeout,
      retry,
      throwHttpErrors,
      maxResponseBytes,
      requestId,
      method,
      ...rest
    } = init;

    const requestIdValue = requestId ?? newRequestId();
    if (!REQUEST_ID.test(requestIdValue)) {
      throw new ConfigurationError("requestId must match [A-Za-z0-9._:-]{1,128}");
    }
    const verb = (method ?? "GET").toUpperCase();
    if (!METHOD.test(verb)) throw new ConfigurationError("Invalid HTTP method");

    const url = resolveUrl(input, this.#base);
    assertSupportedUrl(url);
    const sanitized = sanitizeUrl(url, o.redact);
    assertOriginAllowed(url, this.#base, o.allowedOrigins, sanitized, requestIdValue);

    if (body !== undefined && json !== undefined) {
      throw new ConfigurationError("Pass either body or json, not both", {
        requestId: requestIdValue,
      });
    }
    const merged = mergeHeaders(o.headers, headers);
    let source: BodySource | undefined = body;
    if (json !== undefined) {
      try {
        source = JSON.stringify(json);
      } catch {
        throw new ConfigurationError("json option is not serializable", {
          requestId: requestIdValue,
        });
      }
      if (source === undefined) throw new ConfigurationError("json option is not serializable");
      if (!merged.has("content-type")) merged.set("content-type", "application/json");
    }
    if ((verb === "GET" || verb === "HEAD") && source != null) {
      throw new ConfigurationError(`${verb} requests cannot have a body`, {
        requestId: requestIdValue,
      });
    }

    const attemptTimeout =
      timeout !== undefined ? timeout : o.timeout !== undefined ? o.timeout : DEFAULT_TIMEOUT_MS;
    const policy = resolveRetry(o.retry, retry);
    const total = totalTimeout ?? o.totalTimeout;
    const queue = queueTimeout ?? o.queueTimeout;
    if (attemptTimeout !== false) validMs("timeout", attemptTimeout);
    if (total !== undefined) validMs("totalTimeout", total);
    if (queue !== undefined) validMs("queueTimeout", queue);
    const maxBytes = maxResponseBytes ?? o.maxResponseBytes;
    if (maxBytes !== undefined) validCount("maxResponseBytes", maxBytes);

    return {
      url,
      sanitized,
      method: verb,
      headers: merged,
      body: source,
      replayable: !(source != null && typeof source !== "function" && isStream(source)),
      rest,
      requestId: requestIdValue,
      signal: signal ?? undefined,
      timeout: attemptTimeout === false ? undefined : attemptTimeout,
      totalTimeout: total,
      queueTimeout: queue,
      retry: policy,
      throwHttpErrors: throwHttpErrors ?? o.throwHttpErrors ?? true,
      maxResponseBytes: maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    };
  }

  #emit(event: SteadyFetchEvent): void {
    const handler = this.#options.onEvent;
    if (!handler) return;
    try {
      const result = handler(freezeEvent(event)) as unknown;
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).then(undefined, (e: unknown) => this.#hookError(e));
      }
    } catch (error) {
      this.#hookError(error);
    }
  }

  #hookError(error: unknown): void {
    try {
      this.#options.onHookError?.(error);
    } catch {
      /* a failing error handler must not affect requests */
    }
  }

  async #run(input: string | URL, init: RequestOptions): Promise<RunResult> {
    if (this.#closed) throw new ConfigurationError("The client has been closed");
    const p = this.#prepare(input, init);
    const startedAt = Date.now();
    const state = { attempts: 0, queueWaitMs: 0, retryDelayMs: 0 };
    const base = { requestId: p.requestId, method: p.method, url: p.sanitized };
    const meta = () => ({ requestId: p.requestId, attempts: state.attempts, url: p.sanitized });

    const op = new Scope();
    this.#ops.add(op);
    if (p.signal) op.linkSignal(p.signal, "caller");
    if (p.totalTimeout !== undefined) op.startTimer(p.totalTimeout, "total-timeout");
    const deadlineAt = p.totalTimeout !== undefined ? startedAt + p.totalTimeout : undefined;

    this.#emit({ ...base, type: "request:start", timestamp: startedAt });

    const finish = (outcome: Outcome, extra: { status?: number; errorCode?: ErrorCode }) =>
      this.#emit({
        ...base,
        type: "request:end",
        timestamp: Date.now(),
        outcome,
        attempts: state.attempts,
        durationMs: Date.now() - startedAt,
        queueWaitMs: state.queueWaitMs,
        retryDelayMs: state.retryDelayMs,
        ...extra,
      });

    try {
      for (;;) {
        if (op.signal.aborted) throw this.#abortError(op.cause, p, meta());
        const outcome = await this.#attempt(op, p, state, meta);

        let failure: Failure;
        let response: Response | undefined;
        let error: NetworkError | TimeoutError | undefined;
        if ("response" in outcome) {
          response = outcome.response;
          if (response.status < 400) {
            finish("success", { status: response.status });
            return { response, requestId: p.requestId, url: p.sanitized, attempts: state.attempts };
          }
          failure = {
            type: "status",
            status: response.status,
            retryAfter: response.headers.get("retry-after"),
          };
        } else {
          error = outcome.error;
          failure = error instanceof TimeoutError ? { type: "timeout" } : { type: "network" };
        }

        const info: RetryInfo = {
          attempt: state.attempts,
          method: p.method,
          ...(failure.type === "status" ? { status: failure.status } : { errorKind: failure.type }),
        };
        let eligible: boolean;
        try {
          eligible = p.retry.shouldRetry
            ? (await p.retry.shouldRetry(info)) === true
            : isDefaultEligible(p.retry, p.method, failure);
        } catch (hookError) {
          this.#hookError(hookError);
          eligible = false;
        }

        const decision = decideRetry({
          policy: p.retry,
          eligible,
          attempt: state.attempts,
          failure,
          replayable: p.replayable,
          totalDelayMs: state.retryDelayMs,
          remainingMs: deadlineAt !== undefined ? deadlineAt - Date.now() : undefined,
        });

        if (decision.retry) {
          discardBody(response?.body);
          state.retryDelayMs += decision.delayMs;
          this.#emit({
            ...base,
            type: "retry:scheduled",
            timestamp: Date.now(),
            attempt: state.attempts,
            delayMs: decision.delayMs,
            reason:
              failure.type === "status"
                ? "status"
                : failure.type === "timeout"
                  ? "timeout"
                  : "network-error",
            ...(failure.type === "status" ? { status: failure.status } : {}),
          });
          try {
            await sleep(decision.delayMs, op.signal);
          } catch (e) {
            if (e instanceof WaitAborted) throw this.#abortError(op.cause, p, meta());
            throw e;
          }
          continue;
        }

        // Terminal: build the error that describes the final failure.
        const underlying = (): SteadyFetchError =>
          error ??
          new HttpError(
            failure.type === "status" ? failure.status : 0,
            response?.statusText ?? "",
            meta(),
          );

        if (decision.reason === "not-eligible") {
          if (response) {
            if (!p.throwHttpErrors) {
              finish("http-error", { status: response.status });
              return {
                response,
                requestId: p.requestId,
                url: p.sanitized,
                attempts: state.attempts,
              };
            }
            throw new HttpError(response.status, response.statusText, meta(), response);
          }
          throw error as SteadyFetchError;
        }
        if (response && !p.throwHttpErrors && decision.reason !== "body-not-replayable") {
          finish("http-error", { status: response.status });
          return { response, requestId: p.requestId, url: p.sanitized, attempts: state.attempts };
        }
        discardBody(response?.body);
        const cause = underlying();
        const status = response?.status;
        if (decision.reason === "body-not-replayable") {
          throw new BodyNotReplayableError({ ...meta(), status, cause });
        }
        throw new RetryExhaustedError(decision.reason, { ...meta(), status, cause });
      }
    } catch (error) {
      const e = error instanceof SteadyFetchError ? error : undefined;
      finish(outcomeOf(e), {
        ...(e?.status !== undefined ? { status: e.status } : {}),
        ...(e ? { errorCode: e.code } : {}),
      });
      throw error;
    } finally {
      op.dispose();
      this.#ops.delete(op);
    }
  }

  async #attempt(
    op: Scope,
    p: Prepared,
    state: { attempts: number; queueWaitMs: number },
    meta: () => { requestId: string; attempts: number; url: string },
  ): Promise<AttemptOutcome> {
    const o = this.#options;
    const waitStart = Date.now();
    const queue = new Scope();
    queue.linkScope(op);
    if (p.queueTimeout !== undefined) queue.startTimer(p.queueTimeout, "queue-timeout");
    let release: () => void = noop;
    try {
      // Order: concurrency permit first, then rate-limit slot, so a request starts the
      // moment its slot is granted. The permit is released before any retry sleep.
      if (this.#limiters.concurrency)
        release = await this.#limiters.concurrency.acquire(queue.signal);
      if (this.#limiters.rate) await this.#limiters.rate.acquire(queue.signal);
    } catch (e) {
      release();
      throw this.#waitError(e, queue, p, meta());
    } finally {
      queue.dispose();
    }
    const queueWaitMs = Date.now() - waitStart;
    state.queueWaitMs += queueWaitMs;

    const attempt = new Scope();
    attempt.linkScope(op);
    if (p.timeout !== undefined) attempt.startTimer(p.timeout, "attempt-timeout");
    const attemptNo = ++state.attempts;
    const t0 = Date.now();
    const base = { requestId: p.requestId, method: p.method, url: p.sanitized };
    try {
      // Re-validate immediately before network access, for every attempt.
      assertOriginAllowed(p.url, this.#base, o.allowedOrigins, p.sanitized, p.requestId);

      const headers = new Headers(p.headers);
      if (o.requestIdHeader) headers.set(o.requestIdHeader, p.requestId);
      if (o.beforeAttempt) {
        await o.beforeAttempt({
          requestId: p.requestId,
          attempt: attemptNo,
          method: p.method,
          url: p.url.href,
          headers,
        });
      }
      if (attempt.signal.aborted) throw this.#abortError(attempt.cause, p, meta());

      this.#emit({
        ...base,
        type: "attempt:start",
        timestamp: t0,
        attempt: attemptNo,
        queueWaitMs,
      });

      const signal =
        p.signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([p.signal, attempt.signal])
          : attempt.signal;
      const requestInit: RequestInit & { duplex?: "half" } = {
        ...p.rest,
        method: p.method,
        headers,
        signal,
      };
      if (p.body != null) {
        const body = typeof p.body === "function" ? p.body() : p.body;
        if (body != null) {
          requestInit.body = body;
          if (isStream(body)) requestInit.duplex = "half";
        }
      }

      let response: Response;
      try {
        response = await this.#fetchImpl()(p.url.href, requestInit);
      } catch (e) {
        if (e instanceof SteadyFetchError) throw e;
        const cause = attempt.cause ?? (p.signal?.aborted ? "caller" : undefined);
        this.#emit({
          ...base,
          type: "attempt:end",
          timestamp: Date.now(),
          attempt: attemptNo,
          durationMs: Date.now() - t0,
          errorCode: codeForCause(cause),
        });
        if (cause === "attempt-timeout")
          return { error: new TimeoutError("attempt", p.timeout, meta()) };
        if (cause !== undefined) throw this.#abortError(cause, p, meta());
        return { error: new NetworkError("Network request failed", { ...meta(), cause: e }) };
      }

      if (response.redirected) {
        let finalUrl: URL | undefined;
        try {
          finalUrl = new URL(response.url);
        } catch {
          finalUrl = undefined;
        }
        if (!finalUrl || !isOriginAllowed(finalUrl, this.#base, o.allowedOrigins)) {
          discardBody(response.body);
          throw new OriginNotAllowedError(
            'The response came from a redirect to a disallowed origin (the redirected request was already sent; use redirect: "error" or "manual" to prevent it)',
            { ...meta(), url: sanitizeUrl(response.url, o.redact) },
          );
        }
      }
      this.#emit({
        ...base,
        type: "attempt:end",
        timestamp: Date.now(),
        attempt: attemptNo,
        durationMs: Date.now() - t0,
        status: response.status,
      });
      return { response };
    } finally {
      release();
      attempt.dispose();
    }
  }

  #fetchImpl(): typeof fetch {
    const impl =
      this.#options.fetch ??
      (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
    if (!impl) {
      throw new ConfigurationError(
        "No fetch implementation found; pass one via the `fetch` option (steadyfetch does not polyfill)",
      );
    }
    return impl;
  }

  #abortError(
    cause: AbortCause | undefined,
    p: Prepared,
    meta: { requestId: string; attempts: number; url: string },
  ): SteadyFetchError {
    switch (cause) {
      case "client-closed":
        return new AbortError("client-closed", meta);
      case "total-timeout":
        return new TimeoutError("total", p.totalTimeout, meta);
      case "queue-timeout":
        return new TimeoutError("queue", p.queueTimeout, meta);
      case "attempt-timeout":
        return new TimeoutError("attempt", p.timeout, meta);
      default:
        return new AbortError("caller", meta);
    }
  }

  #waitError(
    e: unknown,
    queue: Scope,
    p: Prepared,
    meta: { requestId: string; attempts: number; url: string },
  ): unknown {
    if (e instanceof WaitAborted) return this.#abortError(queue.cause, p, meta);
    if (e instanceof QueueFullError) return new QueueFullError(e.kind, e.maxQueueSize, meta);
    return e;
  }
}

function codeForCause(cause: AbortCause | undefined): ErrorCode {
  switch (cause) {
    case undefined:
      return "NETWORK_ERROR";
    case "caller":
    case "client-closed":
      return "REQUEST_ABORTED";
    case "queue-timeout":
      return "QUEUE_TIMEOUT";
    default:
      return "REQUEST_TIMEOUT";
  }
}

function outcomeOf(error: SteadyFetchError | undefined): Outcome {
  switch (error?.code) {
    case undefined:
      return "error";
    case "HTTP_ERROR":
      return "http-error";
    case "NETWORK_ERROR":
      return "network-error";
    case "REQUEST_TIMEOUT":
    case "QUEUE_TIMEOUT":
      return "timeout";
    case "REQUEST_ABORTED":
      return "aborted";
    case "RETRY_EXHAUSTED":
      return "retry-exhausted";
    default:
      return "error";
  }
}

export function createSteadyFetch(options: ClientOptions = {}): SteadyFetchClient {
  return new SteadyFetchClient(options);
}
