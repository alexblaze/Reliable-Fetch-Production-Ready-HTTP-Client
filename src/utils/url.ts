import { ConfigurationError, OriginNotAllowedError } from "../errors/errors.js";

export type AllowedOrigins = readonly string[] | ((url: URL) => boolean);

const ABSOLUTE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function invalid(message: string): ConfigurationError {
  return new ConfigurationError(message, {}, "INVALID_URL");
}

/** Throws unless `url` is http(s) without embedded credentials. */
export function assertSupportedUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid(`Unsupported URL scheme "${url.protocol}"; only http: and https: are allowed`);
  }
  if (url.username !== "" || url.password !== "") {
    throw invalid("URLs with embedded credentials are not allowed; use headers instead");
  }
  if (url.hostname === "") throw invalid("URL has no host");
}

/** Parses the base URL and normalizes its path so it ends with "/" (for joining). */
export function parseBaseURL(baseURL: string | URL): URL {
  let base: URL;
  try {
    base = new URL(typeof baseURL === "string" ? baseURL : baseURL.href);
  } catch {
    throw invalid("baseURL is not a valid absolute URL");
  }
  assertSupportedUrl(base);
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}

/**
 * Resolves `input` against `base` with the URL API (never string concatenation).
 *  - relative paths are joined under the base path and may not escape it
 *    (`../` out of the base prefix, `//host`, `\\host` are all rejected);
 *  - absolute URLs are returned as-is; whether they are allowed is decided by
 *    `assertOriginAllowed`.
 */
export function resolveUrl(input: string | URL, base: URL | undefined): URL {
  if (input instanceof URL) return new URL(input.href);
  if (typeof input !== "string") throw invalid("Request input must be a string or URL");
  if (CONTROL_CHARS.test(input)) throw invalid("URL contains control characters");

  const isAbsolute = ABSOLUTE.test(input);
  const isSchemeRelative = /^[\\/]{2}/.test(input);
  try {
    if (isAbsolute) return new URL(input);
    if (!base) throw invalid("A relative URL requires a baseURL");
    if (isSchemeRelative) return new URL(input, base); // origin check rejects foreign hosts
    const path = input.startsWith("/") ? input.slice(1) : input;
    const resolved = new URL(path, base);
    if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
      throw invalid("Relative URL escapes the configured baseURL");
    }
    return resolved;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw invalid("Request URL is not valid");
  }
}

/**
 * Origin policy, evaluated on the FINAL resolved URL.
 *  - `allowedOrigins` set: URL origin must be listed (or equal the base origin) / satisfy the predicate;
 *  - otherwise, with a baseURL: only the base origin is allowed;
 *  - otherwise (no baseURL, no list): unrestricted.
 */
export function isOriginAllowed(
  url: URL,
  base: URL | undefined,
  allowed: AllowedOrigins | undefined,
): boolean {
  if (typeof allowed === "function") return allowed(new URL(url.href)) === true;
  if (base && url.origin === base.origin) return true;
  if (allowed) return allowed.some((o) => safeOrigin(o) === url.origin);
  return base === undefined;
}

export function assertOriginAllowed(
  url: URL,
  base: URL | undefined,
  allowed: AllowedOrigins | undefined,
  sanitizedUrl: string,
  requestId?: string,
): void {
  if (!isOriginAllowed(url, base, allowed)) {
    throw new OriginNotAllowedError(`Origin "${url.origin}" is not allowed by the origin policy`, {
      url: sanitizedUrl,
      requestId,
    });
  }
}

function safeOrigin(origin: string): string | undefined {
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}
