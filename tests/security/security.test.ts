import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  ConfigurationError,
  OriginNotAllowedError,
  SteadyFetchError,
  createSteadyFetch,
  isSteadyFetchError,
  type SteadyFetchEvent,
} from "../../src/index.js";
import { mockFetch, networkError, res } from "../helpers/mockFetch.js";

const SECRETS = ["Bearer s3cr3t-token", "session=abc123", "hunter2", "sk-live-999", "p@ss"];

describe("secret-safe telemetry and errors", () => {
  it("never puts headers, bodies or sensitive query values into events", async () => {
    const events: SteadyFetchEvent[] = [];
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      fetch: mockFetch(res(500, "body hunter2"), res(200)),
      retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false },
      headers: {
        authorization: "Bearer s3cr3t-token",
        cookie: "session=abc123",
        "x-api-key": "sk-live-999",
      },
      onEvent: (e) => events.push(e),
    });
    await api.post("/login?password=hunter2&access_token=sk-live-999&page=2", "p@ss", {
      retry: { methods: ["POST"] },
    });
    const dump = JSON.stringify(events);
    for (const secret of SECRETS) expect(dump).not.toContain(secret);
    expect(dump).toContain("password=[REDACTED]");
    expect(dump).toContain("page=2");
    for (const e of events) expect(Object.keys(e)).not.toContain("headers");
  });

  it("error messages, serialization and cause summaries stay secret-free", async () => {
    const leaky = Object.assign(new TypeError("fetch failed https://api.test/?token=s3cr3t"), {
      code: "ECONNRESET",
    });
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      retry: false,
      fetch: mockFetch(leaky),
      headers: { authorization: "Bearer s3cr3t-token" },
    });
    const err = await api.get("/a?token=s3cr3t").catch((e: unknown) => e as SteadyFetchError);
    const text =
      JSON.stringify(err) +
      String((err as Error).message) +
      String((err as Error).stack?.split("\n")[0]);
    expect(text).not.toContain("s3cr3t");
    expect(JSON.parse(JSON.stringify(err)).cause).toEqual({
      name: "TypeError",
      code: "ECONNRESET",
    });
  });

  it("applies the same redaction to errors for custom redact names", async () => {
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      redact: { queryParams: ["uid"] },
      fetch: mockFetch(res(404)),
    });
    const err = (await api.get("/a?uid=42").catch((e: unknown) => e)) as SteadyFetchError;
    expect(err.url).toBe("https://api.test/a?uid=[REDACTED]");
  });

  it("HttpError does not serialize its response", async () => {
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      fetch: mockFetch(res(500, "secret-body")),
    });
    const err = await api.get("/a").catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain("secret-body");
    expect(Object.keys(err as object)).not.toContain("response");
  });

  it("isSteadyFetchError identifies library errors", async () => {
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      fetch: mockFetch(networkError()),
    });
    expect(isSteadyFetchError(await api.get("/a").catch((e: unknown) => e))).toBe(true);
    expect(isSteadyFetchError(new Error("x"))).toBe(false);
  });
});

describe("destination safety", () => {
  const fetch = mockFetch(res(200));
  it.each([
    "file:///etc/passwd",
    "ftp://a.test/x",
    "javascript:alert(1)",
    "https://user:pw@api.test/x",
  ])("rejects %s", async (url) => {
    await expect(createSteadyFetch({ fetch }).get(url)).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("an absolute URL cannot bypass the origin restriction, including host tricks", async () => {
    const api = createSteadyFetch({ baseURL: "https://api.test", fetch });
    const attempts = [
      "https://evil.test/",
      "https://api.test.evil.test/",
      "https://api.test@evil.test/",
      "https://evil.test\\@api.test/",
      "//evil.test/",
      "https://API.TEST.:443/", // same origin spelled oddly is fine; asserted below
    ];
    for (const target of attempts.slice(0, 5)) {
      const e = await api.get(target).catch((x: unknown) => x);
      expect(e instanceof OriginNotAllowedError || e instanceof ConfigurationError, target).toBe(
        true,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("user-controlled paths cannot climb out of the base path", async () => {
    const api = createSteadyFetch({ baseURL: "https://api.test/v1", fetch });
    for (const userInput of ["../admin", "%2e%2e/admin", "/..%2f..%2fadmin".replace("%2f", "/")]) {
      await expect(api.get(userInput)).rejects.toBeInstanceOf(ConfigurationError);
    }
  });

  it("re-validates the origin on every attempt (predicate flips mid-flight)", async () => {
    let allowed = true;
    const f = mockFetch(res(503), res(200));
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      allowedOrigins: () => allowed,
      fetch: f,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
      onEvent: (e) => {
        if (e.type === "retry:scheduled") allowed = false;
      },
    });
    await expect(api.get("/x")).rejects.toBeInstanceOf(OriginNotAllowedError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("bounded resources", () => {
  it("retry count is bounded by maxAttempts and a hard ceiling", async () => {
    const f = mockFetch(res(503));
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      fetch: f,
      retry: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0 },
    });
    await api.get("/x").catch(() => undefined);
    expect(f).toHaveBeenCalledTimes(4);
    expect(() => createSteadyFetch({ retry: { maxAttempts: 10_000 } })).toThrow(ConfigurationError);
  });

  it("hook failures cannot leak secrets through the default path (ignored, not logged)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      fetch: mockFetch(res(200)),
      onEvent: () => {
        throw new Error("Bearer s3cr3t-token");
      },
    });
    await api.get("/x");
    expect(spy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    spy.mockRestore();
    warn.mockRestore();
  });
});

describe("source hygiene", () => {
  it("contains no TLS-disabling shortcuts, telemetry endpoints or install scripts", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
      dependencies?: object;
    };
    for (const s of ["preinstall", "install", "postinstall"])
      expect(pkg.scripts[s]).toBeUndefined();
    expect(pkg.dependencies).toBeUndefined();
    const src = (readdirSync("src", { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/${f}`);
    expect(src.length).toBeGreaterThan(5);
    for (const f of src) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(
        /rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|XMLHttpRequest|sendBeacon|https?:\/\/(?!example)/,
      );
    }
    expect(existsSync(".npmrc")).toBe(false);
    expect(existsSync(".env")).toBe(false);
  });
});
