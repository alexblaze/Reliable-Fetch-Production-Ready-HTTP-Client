import { describe, expect, it } from "vitest";
import { sanitizeUrl, ConfigurationError, OriginNotAllowedError } from "../../src/index.js";
import {
  assertOriginAllowed,
  assertSupportedUrl,
  isOriginAllowed,
  parseBaseURL,
  resolveUrl,
} from "../../src/utils/url.js";
import { mergeHeaders } from "../../src/utils/headers.js";

describe("resolveUrl", () => {
  const base = parseBaseURL("https://api.example.com/v1");
  it("joins under the base path with or without leading slash", () => {
    expect(resolveUrl("/users", base).href).toBe("https://api.example.com/v1/users");
    expect(resolveUrl("users?a=1", base).href).toBe("https://api.example.com/v1/users?a=1");
    expect(resolveUrl("", base).href).toBe("https://api.example.com/v1/");
  });
  it("keeps queries and drops nothing from absolute same-origin URLs", () => {
    expect(resolveUrl("https://api.example.com/other?x=1#f", base).href).toBe(
      "https://api.example.com/other?x=1#f",
    );
  });
  it.each(["../admin", "/../admin", "a/../../admin", "%2e%2e/admin"])(
    "rejects escaping the base path: %s",
    (p) => {
      expect(() => resolveUrl(p, base)).toThrow(ConfigurationError);
    },
  );
  it.each(["//evil.example/x", "\\\\evil.example\\x", "/\\evil.example"])(
    "does not let %s replace the origin",
    (p) => {
      // Scheme-relative input resolves to a foreign origin; the origin policy must reject it.
      const url = resolveUrl(p, base);
      expect(url.origin).toBe("https://evil.example");
      expect(isOriginAllowed(url, base, undefined)).toBe(false);
    },
  );
  it("rejects control characters (URL parser would silently strip them)", () => {
    expect(() => resolveUrl("/a\nb", base)).toThrow(ConfigurationError);
    expect(() => resolveUrl("htt\tps://evil.example", base)).toThrow(ConfigurationError);
  });
  it("requires a base for relative URLs", () => {
    expect(() => resolveUrl("/x", undefined)).toThrow(/baseURL/);
  });
  it("reports INVALID_URL", () => {
    try {
      resolveUrl("http://", undefined);
    } catch (e) {
      expect((e as ConfigurationError).code).toBe("INVALID_URL");
    }
  });
});

describe("URL safety", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/x",
    "javascript:alert(1)",
    "data:text/plain,hi",
  ])("rejects scheme: %s", (u) => {
    expect(() => assertSupportedUrl(resolveUrl(u, undefined))).toThrow(ConfigurationError);
  });
  it("rejects embedded credentials", () => {
    expect(() => assertSupportedUrl(new URL("https://user:pw@example.com/"))).toThrow(
      /credentials/,
    );
    expect(() => parseBaseURL("https://user@example.com")).toThrow(ConfigurationError);
  });
});

describe("origin policy", () => {
  const base = parseBaseURL("https://api.example.com");
  it("with a baseURL only the base origin is allowed by default", () => {
    expect(isOriginAllowed(new URL("https://api.example.com/x"), base, undefined)).toBe(true);
    expect(isOriginAllowed(new URL("https://evil.example/x"), base, undefined)).toBe(false);
    expect(isOriginAllowed(new URL("http://api.example.com/x"), base, undefined)).toBe(false);
    expect(isOriginAllowed(new URL("https://api.example.com:8443/x"), base, undefined)).toBe(false);
  });
  it("allowedOrigins extends the base origin; lookalikes are rejected", () => {
    const allowed = ["https://cdn.example.com"];
    expect(isOriginAllowed(new URL("https://cdn.example.com/a"), base, allowed)).toBe(true);
    expect(isOriginAllowed(new URL("https://cdn.example.com.evil.example/a"), base, allowed)).toBe(
      false,
    );
    expect(isOriginAllowed(new URL("https://evil.example/a"), base, allowed)).toBe(false);
  });
  it("supports predicates and unrestricted clients without a base", () => {
    expect(
      isOriginAllowed(new URL("https://a.test/"), undefined, (u) => u.hostname.endsWith(".test")),
    ).toBe(true);
    expect(isOriginAllowed(new URL("https://x.example/"), undefined, undefined)).toBe(true);
  });
  it("throws ORIGIN_NOT_ALLOWED", () => {
    expect(() =>
      assertOriginAllowed(
        new URL("https://evil.example/"),
        base,
        undefined,
        "https://evil.example/",
      ),
    ).toThrow(OriginNotAllowedError);
  });
});

describe("sanitizeUrl", () => {
  it("redacts sensitive query values, credentials and fragments", () => {
    const out = sanitizeUrl(
      "https://u:p@example.com/a/b?token=abc&Access_Token=x&api-key=k&page=2&email=a@b.c#frag",
    );
    expect(out).toBe(
      "https://example.com/a/b?token=[REDACTED]&Access_Token=[REDACTED]&api-key=[REDACTED]&page=2&email=[REDACTED]",
    );
    expect(out).not.toMatch(/abc|u:p|frag|a@b/);
  });
  it("supports custom names and redact-all", () => {
    expect(sanitizeUrl("https://e.com/?uid=7&page=1", { queryParams: ["UID"] })).toContain(
      "uid=[REDACTED]",
    );
    expect(sanitizeUrl("https://e.com/?page=1", { allQueryValues: true })).toBe(
      "https://e.com/?page=[REDACTED]",
    );
  });
  it("never throws on garbage", () => expect(sanitizeUrl("not a url")).toBe("[invalid-url]"));
});

describe("mergeHeaders", () => {
  it("later sources win, names are case-insensitive", () => {
    const h = mergeHeaders(
      { "X-A": "1", "x-b": "1" },
      [["x-a", "2"]],
      undefined,
      new Headers({ "X-C": "3" }),
    );
    expect(Object.fromEntries(h)).toEqual({ "x-a": "2", "x-b": "1", "x-c": "3" });
  });
});
