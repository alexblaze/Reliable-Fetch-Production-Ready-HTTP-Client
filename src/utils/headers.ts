/**
 * Precedence (lowest to highest): client default headers, per-request headers.
 * `beforeAttempt` hooks run last, on a per-attempt copy.
 */
export function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => merged.set(key, value));
  }
  return merged;
}
