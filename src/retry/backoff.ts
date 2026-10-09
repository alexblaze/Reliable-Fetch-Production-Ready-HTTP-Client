export interface BackoffOptions {
  backoff: "exponential" | "fixed";
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

/**
 * Delay before retry number `retryIndex` (0 for the first retry).
 * exponential: min(maxDelayMs, baseDelayMs * 2^retryIndex); fixed: min(maxDelayMs, baseDelayMs).
 * jitter=true picks uniformly in [delay/2, delay] ("equal jitter"), which keeps
 * a minimum back-off while de-synchronizing clients. `random` must return [0,1).
 */
export function computeBackoff(
  retryIndex: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const exponent = options.backoff === "exponential" ? Math.min(Math.max(retryIndex, 0), 40) : 0;
  const raw = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** exponent);
  if (!options.jitter) return raw;
  return Math.floor(raw / 2 + random() * (raw / 2));
}
