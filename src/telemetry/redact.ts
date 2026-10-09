export const REDACTED = "[REDACTED]";

const SENSITIVE_EXACT = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "key",
  "password",
  "passwd",
  "pwd",
  "secret",
  "session",
  "sessionid",
  "sid",
  "email",
  "auth",
  "authorization",
  "code",
  "sig",
  "signature",
  "jwt",
  "bearer",
  "credential",
  "credentials",
  "phone",
  "ssn",
]);
const SENSITIVE_SUBSTRINGS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "authoriz",
  "credential",
  "signature",
];

export interface RedactOptions {
  /** Extra query-parameter names (case-insensitive) whose values are redacted. */
  queryParams?: readonly string[];
  /** Redact every query value. Safest option for high-sensitivity apps. */
  allQueryValues?: boolean;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_.\s]/g, "");
}

export function isSensitiveParam(name: string, extra: readonly string[] = []): boolean {
  const n = normalize(name);
  if (SENSITIVE_EXACT.has(n)) return true;
  if (SENSITIVE_SUBSTRINGS.some((s) => n.includes(s))) return true;
  return extra.some((e) => normalize(e) === n);
}

/**
 * Returns a log-safe URL: credentials and fragment removed, sensitive query
 * values replaced with `[REDACTED]`. Path segments are NOT inspected, so do not
 * put secrets in paths.
 */
export function sanitizeUrl(input: string | URL, options: RedactOptions = {}): string {
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input.href);
  } catch {
    return "[invalid-url]";
  }
  const parts: string[] = [];
  url.searchParams.forEach((value, key) => {
    const hide = options.allQueryValues === true || isSensitiveParam(key, options.queryParams);
    parts.push(`${encodeURIComponent(key)}=${hide ? REDACTED : encodeURIComponent(value)}`);
  });
  const search = parts.length > 0 ? `?${parts.join("&")}` : "";
  return `${url.protocol}//${url.host}${url.pathname}${search}`;
}
