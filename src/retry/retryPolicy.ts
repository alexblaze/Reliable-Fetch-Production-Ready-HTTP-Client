import { computeBackoff } from "./backoff.js";
import { parseRetryAfter } from "./retryAfter.js";

export interface RetryOptions {
  /** Total attempts INCLUDING the first request. 1 disables retries. Default 1. */
  maxAttempts?: number;
  /** Methods eligible for retry. Default GET, HEAD, OPTIONS. Adding POST/PATCH is an explicit opt-in. */
  methods?: readonly string[];
  /** Response statuses eligible for retry. Default 408, 429, 500, 502, 503, 504. */
  statusCodes?: readonly number[];
  /** Retry when fetch rejects with a network error. Default true. */
  retryOnNetworkError?: boolean;
  /** Retry when an attempt times out. Default false. */
  retryOnTimeout?: boolean;
  backoff?: "exponential" | "fixed";
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Equal jitter in [delay/2, delay]. Default true. */
  jitter?: boolean;
  /** If Retry-After (429/503) exceeds this, do not retry. Default 30_000. */
  maxRetryAfterMs?: number;
  /** Maximum cumulative time spent sleeping between attempts. Default 60_000. */
  maxTotalDelayMs?: number;
  /**
   * Replaces the default eligibility rules (methods/statuses/errors). Attempt
   * count, deadlines, delay budget, cancellation and body replayability are
   * still enforced afterwards and cannot be overridden.
   */
  shouldRetry?: (info: RetryInfo) => boolean | Promise<boolean>;
}

export interface RetryInfo {
  attempt: number;
  method: string;
  status?: number;
  errorKind?: "network" | "timeout";
}

export interface ResolvedRetryPolicy {
  maxAttempts: number;
  methods: ReadonlySet<string>;
  statusCodes: ReadonlySet<number>;
  retryOnNetworkError: boolean;
  retryOnTimeout: boolean;
  backoff: "exponential" | "fixed";
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  maxRetryAfterMs: number;
  maxTotalDelayMs: number;
  shouldRetry: RetryOptions["shouldRetry"];
}

export const HARD_MAX_ATTEMPTS = 20;

export const DEFAULT_RETRY: Omit<ResolvedRetryPolicy, "methods" | "statusCodes"> & {
  methods: readonly string[];
  statusCodes: readonly number[];
} = {
  maxAttempts: 1,
  methods: ["GET", "HEAD", "OPTIONS"],
  statusCodes: [408, 429, 500, 502, 503, 504],
  retryOnNetworkError: true,
  retryOnTimeout: false,
  backoff: "exponential",
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitter: true,
  maxRetryAfterMs: 30_000,
  maxTotalDelayMs: 60_000,
  shouldRetry: undefined,
};

export type Failure =
  | { type: "status"; status: number; retryAfter?: string | null }
  | { type: "network" }
  | { type: "timeout" };

export type StopReason =
  | "not-eligible"
  | "max-attempts"
  | "retry-after-too-long"
  | "budget"
  | "deadline"
  | "body-not-replayable";

export type RetryDecision = { retry: true; delayMs: number } | { retry: false; reason: StopReason };

export function isDefaultEligible(
  policy: ResolvedRetryPolicy,
  method: string,
  failure: Failure,
): boolean {
  if (!policy.methods.has(method)) return false;
  switch (failure.type) {
    case "status":
      return policy.statusCodes.has(failure.status);
    case "network":
      return policy.retryOnNetworkError;
    case "timeout":
      return policy.retryOnTimeout;
  }
}

export interface DecideInput {
  policy: ResolvedRetryPolicy;
  /** Result of the eligibility check (default rules or `shouldRetry`). */
  eligible: boolean;
  /** Number of the attempt that just failed (1-based). */
  attempt: number;
  failure: Failure;
  replayable: boolean;
  /** Cumulative sleep so far. */
  totalDelayMs: number;
  /** Time left until the total deadline, if any. */
  remainingMs: number | undefined;
  nowMs?: number;
  random?: () => number;
}

/** Pure decision function; every limit is checked here so it can be tested exhaustively. */
export function decideRetry(input: DecideInput): RetryDecision {
  const { policy, failure } = input;
  if (policy.maxAttempts <= 1 || !input.eligible) return { retry: false, reason: "not-eligible" };
  if (input.attempt >= policy.maxAttempts) return { retry: false, reason: "max-attempts" };

  let delayMs = computeBackoff(input.attempt - 1, policy, input.random);
  if (failure.type === "status" && (failure.status === 429 || failure.status === 503)) {
    const retryAfter = parseRetryAfter(failure.retryAfter, input.nowMs);
    if (retryAfter !== undefined) {
      if (retryAfter > policy.maxRetryAfterMs)
        return { retry: false, reason: "retry-after-too-long" };
      delayMs = Math.max(delayMs, retryAfter);
    }
  }
  if (input.totalDelayMs + delayMs > policy.maxTotalDelayMs)
    return { retry: false, reason: "budget" };
  if (input.remainingMs !== undefined && delayMs >= input.remainingMs)
    return { retry: false, reason: "deadline" };
  if (!input.replayable) return { retry: false, reason: "body-not-replayable" };
  return { retry: true, delayMs };
}
