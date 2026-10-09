/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined for invalid values. Past dates yield 0. The result is NOT
 * capped here; callers must bound it.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  // HTTP-date must contain a year and a time of day; reject loose Date.parse inputs like "5".
  if (!/\d{4}/.test(trimmed) || !/\d{1,2}:\d{2}/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}
