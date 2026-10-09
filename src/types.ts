import type { SteadyFetchEvent } from "./telemetry/events.js";
import type { RedactOptions } from "./telemetry/redact.js";
import type { RetryOptions } from "./retry/retryPolicy.js";
import type { AllowedOrigins } from "./utils/url.js";

export type BodySource = BodyInit | null | (() => BodyInit | null);

export interface ConcurrencyOptions {
  /** Maximum simultaneously active attempts (until response headers arrive). */
  limit: number;
  /** Maximum queued attempts before QueueFullError. Default 10_000. */
  maxQueueSize?: number;
}

export interface RateLimitOptions {
  /** Maximum attempt starts per `intervalMs` (also the burst size). */
  limit: number;
  intervalMs: number;
  /** Maximum queued attempts before QueueFullError. Default 10_000. */
  maxQueueSize?: number;
}

export interface AttemptContext {
  readonly requestId: string;
  /** 1-based network attempt number. */
  readonly attempt: number;
  readonly method: string;
  /** Real (unredacted) URL. Do not log it. */
  readonly url: string;
  /** Per-attempt copy; mutations affect only this attempt. */
  readonly headers: Headers;
}

export interface ClientOptions {
  /** Base URL for relative paths. Requests may not leave its origin unless `allowedOrigins` says so. */
  baseURL?: string | URL;
  /** Origins (or a predicate) that requests and redirects may target. */
  allowedOrigins?: AllowedOrigins;
  /** Default headers (lowest precedence). */
  headers?: HeadersInit;
  /** Per-attempt timeout until response headers arrive. Default 30_000. `false` disables. */
  timeout?: number | false;
  /** Deadline for the whole logical request, including queueing and retry delays. Default none. */
  totalTimeout?: number;
  /** Maximum time to wait for concurrency/rate-limit capacity per attempt. Default none. */
  queueTimeout?: number;
  /** Retry policy. Retries are off by default (maxAttempts = 1). `false` disables explicitly. */
  retry?: RetryOptions | false;
  concurrency?: ConcurrencyOptions;
  rateLimit?: RateLimitOptions;
  /** Throw HttpError for status >= 400. Default true. */
  throwHttpErrors?: boolean;
  /** Size limit for `json()` parsing. Default 10 MiB. */
  maxResponseBytes?: number;
  /** Injected fetch implementation. Defaults to the global `fetch` (never polyfilled). */
  fetch?: typeof fetch;
  /** Structured, redacted lifecycle events. Errors thrown by it never affect requests. */
  onEvent?: (event: SteadyFetchEvent) => void;
  /** Receives exceptions thrown by `onEvent` / `retry.shouldRetry`. Default: ignored. */
  onHookError?: (error: unknown) => void;
  /** Runs before every network attempt (not once per logical request). */
  beforeAttempt?: (context: AttemptContext) => void | Promise<void>;
  redact?: RedactOptions;
  /** If set, the request id is sent in this header on every attempt. */
  requestIdHeader?: string;
}

export interface RequestOptions extends Omit<RequestInit, "body" | "headers"> {
  headers?: HeadersInit;
  /**
   * Request body. Use a function returning a fresh body (e.g. `() => stream`)
   * to make streaming bodies retryable. Raw ReadableStream bodies are never retried.
   */
  body?: BodySource;
  /** Convenience: JSON-serialized body with `content-type: application/json`. Mutually exclusive with `body`. */
  json?: unknown;
  timeout?: number | false;
  totalTimeout?: number;
  queueTimeout?: number;
  /** Merged over the client retry policy; `false` disables retries for this request. */
  retry?: RetryOptions | false;
  throwHttpErrors?: boolean;
  maxResponseBytes?: number;
  /** Non-sensitive correlation id (`[A-Za-z0-9._:-]{1,128}`). Generated when omitted. */
  requestId?: string;
}

/** Options for verb helpers; the body is a positional argument. */
export type VerbOptions = Omit<RequestOptions, "method">;

export interface JsonResult<T> {
  data: T;
  response: Response;
}
