import type { ErrorCode } from "../errors/errors.js";

export type Outcome =
  "success" | "http-error" | "network-error" | "timeout" | "aborted" | "retry-exhausted" | "error";

interface Base {
  readonly requestId: string;
  readonly method: string;
  /** Sanitized URL (credentials, fragment and sensitive query values removed). */
  readonly url: string;
  readonly timestamp: number;
}

/**
 * Structured lifecycle events. They never contain headers, bodies, or raw URLs.
 * Payloads are frozen. `request:*` events fire once per logical request;
 * `attempt:*` and `retry:scheduled` fire per network attempt.
 */
export type SteadyFetchEvent =
  | (Base & { readonly type: "request:start" })
  | (Base & {
      readonly type: "attempt:start";
      readonly attempt: number;
      readonly queueWaitMs: number;
    })
  | (Base & {
      readonly type: "attempt:end";
      readonly attempt: number;
      readonly durationMs: number;
      readonly status?: number;
      readonly errorCode?: ErrorCode;
    })
  | (Base & {
      readonly type: "retry:scheduled";
      readonly attempt: number;
      readonly delayMs: number;
      readonly reason: "status" | "network-error" | "timeout";
      readonly status?: number;
    })
  | (Base & {
      readonly type: "request:end";
      readonly outcome: Outcome;
      readonly attempts: number;
      readonly durationMs: number;
      readonly queueWaitMs: number;
      readonly retryDelayMs: number;
      readonly status?: number;
      readonly errorCode?: ErrorCode;
    });

export function freezeEvent<T extends SteadyFetchEvent>(event: T): T {
  return Object.freeze(event);
}
