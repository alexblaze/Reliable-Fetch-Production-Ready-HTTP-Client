/** Stable, machine-readable error codes. Part of the public API (semver-protected). */
export type ErrorCode =
  | "CONFIGURATION_ERROR"
  | "INVALID_URL"
  | "REQUEST_TIMEOUT"
  | "QUEUE_TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "RESPONSE_PARSE_ERROR"
  | "REQUEST_ABORTED"
  | "RETRY_EXHAUSTED"
  | "BODY_NOT_REPLAYABLE"
  | "ORIGIN_NOT_ALLOWED"
  | "RATE_LIMIT_QUEUE_FULL"
  | "CONCURRENCY_QUEUE_FULL";

export interface ErrorMetadata {
  requestId?: string | undefined;
  /** Number of network attempts started so far. */
  attempts?: number | undefined;
  /** HTTP status if a response exists. */
  status?: number | undefined;
  /** Sanitized (redacted) URL. Never the raw URL. */
  url?: string | undefined;
  cause?: unknown;
}

const BRAND = Symbol.for("steadyfetch.error");

/** Base class for every error thrown by steadyfetch. */
export class SteadyFetchError extends Error {
  readonly code: ErrorCode;
  readonly requestId: string | undefined;
  attempts: number | undefined;
  readonly status: number | undefined;
  readonly url: string | undefined;
  readonly [BRAND] = true;

  constructor(code: ErrorCode, message: string, meta: ErrorMetadata = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = "SteadyFetchError";
    this.code = code;
    this.requestId = meta.requestId;
    this.attempts = meta.attempts;
    this.status = meta.status;
    this.url = meta.url;
  }

  /**
   * Safe serialization for logs. The `cause` is reduced to its class name and
   * code: arbitrary causes (e.g. undici errors) may embed hosts or secrets.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      requestId: this.requestId,
      attempts: this.attempts,
      status: this.status,
      url: this.url,
      cause: summarizeCause(this.cause),
    };
  }
}

function summarizeCause(cause: unknown): unknown {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return { name: cause.name, ...(typeof code === "string" ? { code } : {}) };
  }
  return { type: typeof cause };
}

/** Works across realms/duplicate installs, unlike a bare `instanceof`. */
export function isSteadyFetchError(value: unknown): value is SteadyFetchError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[BRAND] === true
  );
}

export class ConfigurationError extends SteadyFetchError {
  constructor(
    message: string,
    meta: ErrorMetadata = {},
    code: "CONFIGURATION_ERROR" | "INVALID_URL" = "CONFIGURATION_ERROR",
  ) {
    super(code, message, meta);
    this.name = "ConfigurationError";
  }
}

/** `QUEUE_TIMEOUT` (waited too long for capacity) or `REQUEST_TIMEOUT`. */
export class TimeoutError extends SteadyFetchError {
  readonly phase: "queue" | "attempt" | "total";
  constructor(
    phase: "queue" | "attempt" | "total",
    timeoutMs: number | undefined,
    meta: ErrorMetadata = {},
  ) {
    super(
      phase === "queue" ? "QUEUE_TIMEOUT" : "REQUEST_TIMEOUT",
      `Request timed out (${phase}${timeoutMs !== undefined ? `, ${timeoutMs}ms` : ""})`,
      meta,
    );
    this.name = "TimeoutError";
    this.phase = phase;
  }
}

export class NetworkError extends SteadyFetchError {
  constructor(message: string, meta: ErrorMetadata = {}) {
    super("NETWORK_ERROR", message, meta);
    this.name = "NetworkError";
  }
}

export class HttpError extends SteadyFetchError {
  readonly statusText: string;
  /**
   * The response, when this error was thrown for a non-2xx result. Its body is
   * NOT consumed: read or cancel it (`await error.response?.body?.cancel()`).
   * Not enumerable, so it is never serialized into logs.
   */
  readonly response: Response | undefined;

  constructor(status: number, statusText: string, meta: ErrorMetadata = {}, response?: Response) {
    super("HTTP_ERROR", `Request failed with HTTP status ${status}`, { ...meta, status });
    this.name = "HttpError";
    this.statusText = statusText;
    Object.defineProperty(this, "response", { value: response, enumerable: false });
  }
}

export class ParseError extends SteadyFetchError {
  readonly contentType: string | null;
  constructor(message: string, contentType: string | null, meta: ErrorMetadata = {}) {
    super("RESPONSE_PARSE_ERROR", message, meta);
    this.name = "ParseError";
    this.contentType = contentType;
  }
}

/** Caller cancellation or client shutdown. Named `AbortError` to match platform convention. */
export class AbortError extends SteadyFetchError {
  readonly reason: "caller" | "client-closed";
  constructor(reason: "caller" | "client-closed", meta: ErrorMetadata = {}) {
    super(
      "REQUEST_ABORTED",
      reason === "caller"
        ? "Request was aborted by the caller"
        : "Request was aborted because the client was closed",
      meta,
    );
    this.name = "AbortError";
    this.reason = reason;
  }
}

export type RetryStopReason = "max-attempts" | "retry-after-too-long" | "budget" | "deadline";

export class RetryExhaustedError extends SteadyFetchError {
  readonly reason: RetryStopReason;
  constructor(reason: RetryStopReason, meta: ErrorMetadata = {}) {
    super(
      "RETRY_EXHAUSTED",
      `Retries exhausted after ${meta.attempts ?? "?"} attempt(s): ${reason}`,
      meta,
    );
    this.name = "RetryExhaustedError";
    this.reason = reason;
  }
}

export class BodyNotReplayableError extends SteadyFetchError {
  constructor(meta: ErrorMetadata = {}) {
    super(
      "BODY_NOT_REPLAYABLE",
      "The request should be retried but its body cannot be replayed; pass the body as a function returning a fresh body",
      meta,
    );
    this.name = "BodyNotReplayableError";
  }
}

export class OriginNotAllowedError extends SteadyFetchError {
  constructor(message: string, meta: ErrorMetadata = {}) {
    super("ORIGIN_NOT_ALLOWED", message, meta);
    this.name = "OriginNotAllowedError";
  }
}

export class QueueFullError extends SteadyFetchError {
  readonly kind: "concurrency" | "rate-limit";
  readonly maxQueueSize: number;
  constructor(kind: "concurrency" | "rate-limit", maxQueueSize: number, meta: ErrorMetadata = {}) {
    super(
      kind === "concurrency" ? "CONCURRENCY_QUEUE_FULL" : "RATE_LIMIT_QUEUE_FULL",
      `The ${kind} queue is full (maxQueueSize=${maxQueueSize})`,
      meta,
    );
    this.name = "QueueFullError";
    this.kind = kind;
    this.maxQueueSize = maxQueueSize;
  }
}
