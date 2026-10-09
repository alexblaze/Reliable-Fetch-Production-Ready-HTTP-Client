import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AbortError,
  BodyNotReplayableError,
  ConfigurationError,
  HttpError,
  NetworkError,
  OriginNotAllowedError,
  QueueFullError,
  RetryExhaustedError,
  TimeoutError,
  createSteadyFetch,
  type SteadyFetchEvent,
} from "../../src/index.js";
import { hang, mockFetch, networkError, res } from "../helpers/mockFetch.js";

const base = {
  baseURL: "https://api.test",
  retry: { maxAttempts: 3, jitter: false, baseDelayMs: 100, maxDelayMs: 1000 },
} as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
});

/** Runs a promise to settlement while advancing fake time. */
async function settle<T>(p: Promise<T>, ms = 120_000): Promise<PromiseSettledResult<T>> {
  const wrapped = p.then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason: unknown) => ({ status: "rejected", reason }) as const,
  );
  await vi.advanceTimersByTimeAsync(ms);
  return wrapped;
}
const rejected = async (p: Promise<unknown>, ms?: number) => {
  const r = await settle(p, ms);
  if (r.status !== "rejected") throw new Error("expected rejection");
  return r.reason as Error & { code: string };
};

describe("retry behaviour", () => {
  it("retries GET 503 then succeeds, emitting per-attempt events", async () => {
    const events: SteadyFetchEvent[] = [];
    const fetch = mockFetch(res(503), res(200, "hi"));
    const api = createSteadyFetch({ ...base, fetch, onEvent: (e) => events.push(e) });
    const r = await settle(api.get("/x"));
    expect(r.status).toBe("fulfilled");
    expect(fetch.calls).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual([
      "request:start",
      "attempt:start",
      "attempt:end",
      "retry:scheduled",
      "attempt:start",
      "attempt:end",
      "request:end",
    ]);
    const end = events.at(-1) as Extract<SteadyFetchEvent, { type: "request:end" }>;
    expect(end).toMatchObject({ outcome: "success", attempts: 2, retryDelayMs: 100, status: 200 });
    expect(Object.isFrozen(end)).toBe(true);
  });

  it("applies exponential backoff between attempts", async () => {
    const events: SteadyFetchEvent[] = [];
    const api = createSteadyFetch({
      ...base,
      retry: { ...base.retry, maxAttempts: 4 },
      fetch: mockFetch(res(500)),
      onEvent: (e) => events.push(e),
    });
    await rejected(api.get("/x"));
    const delays = events.flatMap((e) => (e.type === "retry:scheduled" ? [e.delayMs] : []));
    expect(delays).toEqual([100, 200, 400]);
  });

  it("throws RetryExhaustedError with attempt count and an HttpError cause", async () => {
    const fetch = mockFetch(res(503));
    const api = createSteadyFetch({ ...base, fetch });
    const err = await rejected(api.get("/x"));
    expect(err).toBeInstanceOf(RetryExhaustedError);
    expect(err).toMatchObject({
      code: "RETRY_EXHAUSTED",
      reason: "max-attempts",
      attempts: 3,
      status: 503,
    });
    expect((err.cause as Error).name).toBe("HttpError");
    expect(fetch.calls).toHaveLength(3);
  });

  it("returns the final response when throwHttpErrors is false and retries run out", async () => {
    const api = createSteadyFetch({ ...base, throwHttpErrors: false, fetch: mockFetch(res(503)) });
    const r = await settle(api.get("/x"));
    expect(r.status === "fulfilled" && r.value.status).toBe(503);
  });

  it("never retries POST/PATCH by default, even on 503", async () => {
    for (const method of ["post", "patch"] as const) {
      const fetch = mockFetch(res(503));
      const api = createSteadyFetch({ ...base, fetch });
      const err = await rejected(api[method]("/x", "body"));
      expect(err).toBeInstanceOf(HttpError);
      expect(fetch.calls).toHaveLength(1);
    }
  });

  it("retries POST only with explicit opt-in", async () => {
    const fetch = mockFetch(res(503), res(201));
    const api = createSteadyFetch({ ...base, retry: { ...base.retry, methods: ["POST"] }, fetch });
    const r = await settle(api.post("/x", "body"));
    expect(r.status).toBe("fulfilled");
    expect(fetch.calls).toHaveLength(2);
  });

  it("does not retry 4xx and surfaces HttpError with safe metadata", async () => {
    const api = createSteadyFetch({ ...base, fetch: mockFetch(res(404, "nope")) });
    const err = (await rejected(api.get("/x?token=secret"))) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ code: "HTTP_ERROR", status: 404, attempts: 1 });
    expect(err.url).toBe("https://api.test/x?token=[REDACTED]");
    expect(await err.response?.text()).toBe("nope"); // body is left for the caller
    expect(JSON.stringify(err)).not.toContain("secret");
  });

  it("retries network errors, and not when disabled", async () => {
    const fetch = mockFetch(networkError(), res(200));
    const api = createSteadyFetch({ ...base, fetch });
    expect((await settle(api.get("/x"))).status).toBe("fulfilled");
    expect(fetch.calls).toHaveLength(2);

    const f2 = mockFetch(networkError());
    const off = createSteadyFetch({
      ...base,
      retry: { ...base.retry, retryOnNetworkError: false },
      fetch: f2,
    });
    expect(await rejected(off.get("/x"))).toBeInstanceOf(NetworkError);
    expect(f2.calls).toHaveLength(1);
  });

  it("wraps persistent network errors in RetryExhaustedError with a NetworkError cause", async () => {
    const api = createSteadyFetch({ ...base, fetch: mockFetch(networkError()) });
    const err = await rejected(api.get("/x"));
    expect(err).toBeInstanceOf(RetryExhaustedError);
    expect(err.cause).toBeInstanceOf(NetworkError);
  });

  it("honours Retry-After seconds and HTTP-date for 429/503", async () => {
    const events: SteadyFetchEvent[] = [];
    const date = new Date(Date.now() + 10_000).toUTCString();
    const fetch = mockFetch(
      res(429, "", { "retry-after": "2" }),
      res(503, "", { "retry-after": date }),
      res(200),
    );
    const api = createSteadyFetch({ ...base, fetch, onEvent: (e) => events.push(e) });
    await settle(api.get("/x"));
    const delays = events.flatMap((e) => (e.type === "retry:scheduled" ? [e.delayMs] : []));
    expect(delays[0]).toBe(2000);
    // 10s date minus the 2s already slept; HTTP dates have 1s resolution.
    expect(delays[1]).toBeGreaterThan(6900);
    expect(delays[1]).toBeLessThanOrEqual(8000);
  });

  it("refuses to sleep for an absurd Retry-After", async () => {
    const fetch = mockFetch(res(429, "", { "retry-after": "86400" }));
    const api = createSteadyFetch({ ...base, fetch });
    const err = await rejected(api.get("/x"));
    expect(err).toMatchObject({ code: "RETRY_EXHAUSTED", reason: "retry-after-too-long" });
    expect(fetch.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry non-replayable stream bodies, and cancels the response", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const fetch = mockFetch(() => new Response(body, { status: 503 }));
    const api = createSteadyFetch({ ...base, retry: { ...base.retry, methods: ["PUT"] }, fetch });
    const stream = () =>
      new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("x")), c.close()) });
    const err = await rejected(api.put("/x", stream()));
    expect(err).toBeInstanceOf(BodyNotReplayableError);
    expect(err.code).toBe("BODY_NOT_REPLAYABLE");
    expect(fetch.calls).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it("retries streaming bodies supplied through a factory, with a fresh body each time", async () => {
    const bodies: unknown[] = [];
    const fetch = mockFetch(
      (init) => (bodies.push(init.body), res(503)),
      (init) => (bodies.push(init.body), res(200)),
    );
    const api = createSteadyFetch({ ...base, retry: { ...base.retry, methods: ["PUT"] }, fetch });
    const factory = vi.fn(() => new ReadableStream());
    await settle(api.put("/x", factory));
    expect(factory).toHaveBeenCalledTimes(2);
    expect(bodies[0]).not.toBe(bodies[1]);
    expect(fetch.calls[0]!.init).toMatchObject({ duplex: "half" });
  });

  it("cancels retried response bodies so connections are released", async () => {
    let cancelled = 0;
    const mk = () =>
      new Response(new ReadableStream({ cancel: () => void cancelled++ }), { status: 503 });
    const fetch = mockFetch(mk, mk, res(200));
    const api = createSteadyFetch({ ...base, fetch });
    await settle(api.get("/x"));
    expect(cancelled).toBe(2);
  });

  it("shouldRetry replaces eligibility but cannot exceed maxAttempts", async () => {
    const fetch = mockFetch(res(418));
    const shouldRetry = vi.fn(({ status }: { status?: number }) => status === 418);
    const api = createSteadyFetch({ ...base, retry: { ...base.retry, shouldRetry }, fetch });
    const err = await rejected(api.get("/x"));
    expect(err).toMatchObject({ code: "RETRY_EXHAUSTED" });
    expect(fetch.calls).toHaveLength(3);
  });

  it("treats a throwing shouldRetry as 'do not retry' and reports it", async () => {
    const onHookError = vi.fn();
    const api = createSteadyFetch({
      ...base,
      onHookError,
      retry: {
        ...base.retry,
        shouldRetry: () => {
          throw new Error("boom");
        },
      },
      fetch: mockFetch(res(503)),
    });
    expect(await rejected(api.get("/x"))).toBeInstanceOf(HttpError);
    expect(onHookError).toHaveBeenCalledOnce();
  });

  it("per-request retry:false disables retries", async () => {
    const fetch = mockFetch(res(503));
    const api = createSteadyFetch({ ...base, fetch });
    await rejected(api.get("/x", { retry: false }));
    expect(fetch.calls).toHaveLength(1);
  });

  it("retry attempts count against the rate limiter", async () => {
    const times: number[] = [];
    const t0 = Date.now();
    const fetch = mockFetch(
      () => (times.push(Date.now() - t0), res(503)),
      () => (times.push(Date.now() - t0), res(200)),
    );
    const api = createSteadyFetch({ ...base, rateLimit: { limit: 1, intervalMs: 5000 }, fetch });
    await settle(api.get("/x"));
    expect(times).toEqual([0, 5000]);
  });
});

describe("timeouts and cancellation", () => {
  it("times out an attempt with a distinguishable error and clears timers", async () => {
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      timeout: 100,
      fetch: mockFetch(hang),
    });
    const err = await rejected(api.get("/x"), 1000);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ code: "REQUEST_TIMEOUT", phase: "attempt" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries attempt timeouts only when enabled", async () => {
    const fetch = mockFetch(hang, res(200));
    const api = createSteadyFetch({
      ...base,
      timeout: 100,
      retry: { ...base.retry, retryOnTimeout: true },
      fetch,
    });
    expect((await settle(api.get("/x"), 1000)).status).toBe("fulfilled");
    const f2 = mockFetch(hang);
    const off = createSteadyFetch({ ...base, timeout: 100, fetch: f2 });
    expect(await rejected(off.get("/x"), 1000)).toBeInstanceOf(TimeoutError);
    expect(f2.calls).toHaveLength(1);
  });

  it("totalTimeout covers retry delays and is not retried", async () => {
    const fetch = mockFetch(res(503));
    const api = createSteadyFetch({
      ...base,
      retry: { ...base.retry, baseDelayMs: 1000, maxDelayMs: 1000, maxAttempts: 10 },
      totalTimeout: 2500,
      fetch,
    });
    const err = await rejected(api.get("/x"), 10_000);
    expect(err).toMatchObject({ code: expect.stringMatching(/REQUEST_TIMEOUT|RETRY_EXHAUSTED/) });
    expect(fetch.calls.length).toBeLessThanOrEqual(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("totalTimeout aborts an in-flight attempt as phase 'total'", async () => {
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      timeout: 10_000,
      totalTimeout: 200,
      fetch: mockFetch(hang),
    });
    const err = await rejected(api.get("/x"), 1000);
    expect(err).toMatchObject({ code: "REQUEST_TIMEOUT", phase: "total" });
  });

  it("caller abort during an attempt is AbortError, never retried", async () => {
    const fetch = mockFetch(hang);
    const api = createSteadyFetch({ ...base, fetch });
    const c = new AbortController();
    const p = api.get("/x", { signal: c.signal });
    const out = rejected(p, 10);
    c.abort();
    const err = await out;
    expect(err).toBeInstanceOf(AbortError);
    expect(err.code).toBe("REQUEST_ABORTED");
    expect(fetch.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caller abort during backoff stops the retry loop", async () => {
    const fetch = mockFetch(res(503));
    const api = createSteadyFetch({ ...base, fetch });
    const c = new AbortController();
    const out = rejected(api.get("/x", { signal: c.signal }), 50); // inside the first 100ms delay
    await vi.advanceTimersByTimeAsync(0);
    c.abort();
    expect(await out).toBeInstanceOf(AbortError);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already-aborted signal never reaches fetch", async () => {
    const fetch = mockFetch(res(200));
    const api = createSteadyFetch({ ...base, fetch });
    expect(await rejected(api.get("/x", { signal: AbortSignal.abort() }))).toBeInstanceOf(
      AbortError,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it("does not mutate or leak listeners on the caller's signal", async () => {
    const c = new AbortController();
    const add = vi.spyOn(c.signal, "addEventListener");
    const remove = vi.spyOn(c.signal, "removeEventListener");
    const api = createSteadyFetch({ ...base, fetch: mockFetch(res(200)) });
    await api.get("/x", { signal: c.signal });
    expect(c.signal.aborted).toBe(false);
    expect(add.mock.calls.length).toBeGreaterThan(0);
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
  });
});

describe("concurrency limits", () => {
  it("never exceeds the limit and releases permits on success, failure and sync throw", async () => {
    let active = 0;
    let max = 0;
    const fetch = mockFetch(async (_i, call) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 50));
      active--;
      if (call % 3 === 0) throw networkError();
      return res(200);
    });
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      concurrency: { limit: 2 },
      retry: false,
      fetch,
    });
    const all = Promise.allSettled(Array.from({ length: 10 }, (_, i) => api.get(`/x/${i}`)));
    await vi.advanceTimersByTimeAsync(2000);
    const results = await all;
    expect(max).toBe(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    const throwing = createSteadyFetch({
      baseURL: "https://api.test",
      concurrency: { limit: 1 },
      retry: false,
      fetch: (() => {
        throw new Error("sync");
      }) as unknown as typeof fetch,
    });
    await rejected(throwing.get("/a"));
    await rejected(throwing.get("/b")); // would hang if the permit leaked
  });

  it("queueTimeout rejects a waiting request without consuming the slot", async () => {
    let release!: () => void;
    const fetch = mockFetch((_i, call) =>
      call === 1
        ? new Promise<Response>((r) => (release = () => r(res(200))))
        : Promise.resolve(res(200)),
    );
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      concurrency: { limit: 1 },
      queueTimeout: 100,
      retry: false,
      fetch,
    });
    const first = api.get("/1");
    const err = await rejected(api.get("/2"), 500);
    expect(err).toMatchObject({ code: "QUEUE_TIMEOUT", phase: "queue" });
    release();
    await first;
    expect((await api.get("/3")).status).toBe(200);
    expect(fetch.calls).toHaveLength(2); // the timed-out request never started
  });

  it("caller abort while queued removes the request from the queue", async () => {
    let release!: () => void;
    const fetch = mockFetch((_i, call) =>
      call === 1
        ? new Promise<Response>((r) => (release = () => r(res(200))))
        : Promise.resolve(res(200)),
    );
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      concurrency: { limit: 1 },
      retry: false,
      fetch,
    });
    const first = api.get("/1");
    const c = new AbortController();
    const queued = rejected(api.get("/2", { signal: c.signal }), 10);
    c.abort();
    expect(await queued).toBeInstanceOf(AbortError);
    release();
    await first;
    expect(fetch.calls).toHaveLength(1);
  });

  it("bounds the queue with CONCURRENCY_QUEUE_FULL", async () => {
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      concurrency: { limit: 1, maxQueueSize: 1 },
      retry: false,
      fetch: mockFetch(hang),
      timeout: 1000,
    });
    const a = api.get("/1").catch(() => undefined);
    const b = api.get("/2").catch(() => undefined);
    const err = await rejected(api.get("/3"), 10);
    expect(err).toBeInstanceOf(QueueFullError);
    expect(err.code).toBe("CONCURRENCY_QUEUE_FULL");
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([a, b]);
  });

  it("does not hold a permit while sleeping between retries", async () => {
    // limit 1: while request A sleeps its backoff, request B must be able to run.
    const order: string[] = [];
    const fetch = mockFetch(
      (_i, call) => (order.push(`call${call}`), call === 1 ? res(503) : res(200)),
    );
    const api = createSteadyFetch({ ...base, concurrency: { limit: 1 }, fetch });
    const a = api.get("/a");
    const b = api.get("/b");
    await settle(Promise.all([a, b]), 5000);
    expect(order).toEqual(["call1", "call2", "call3"]);
  });
});

describe("hooks, events and lifecycle", () => {
  it("telemetry exceptions never break requests", async () => {
    const onHookError = vi.fn();
    const api = createSteadyFetch({
      ...base,
      fetch: mockFetch(res(200)),
      onEvent: () => {
        throw new Error("x");
      },
      onHookError,
    });
    expect((await api.get("/x")).status).toBe(200);
    expect(onHookError).toHaveBeenCalled();
    const bad = createSteadyFetch({
      ...base,
      fetch: mockFetch(res(200)),
      onEvent: () => {
        throw new Error("x");
      },
      onHookError: () => {
        throw new Error("y");
      },
    });
    expect((await bad.get("/x")).status).toBe(200);
  });

  it("beforeAttempt runs per attempt on a per-attempt header copy", async () => {
    const seen: Array<string | null> = [];
    const fetch = mockFetch(
      (init) => (seen.push(new Headers(init.headers).get("x-attempt")), res(503)),
      (init) => (seen.push(new Headers(init.headers).get("x-attempt")), res(200)),
    );
    const api = createSteadyFetch({
      ...base,
      fetch,
      beforeAttempt: ({ attempt, headers }) => headers.set("x-attempt", String(attempt)),
    });
    await settle(api.get("/x", { headers: { "x-keep": "1" } }));
    expect(seen).toEqual(["1", "2"]);
    expect(new Headers(fetch.calls[1]!.init.headers).get("x-keep")).toBe("1");
  });

  it("merges headers: client < request, and sends the request id header when configured", async () => {
    const fetch = mockFetch(res(200));
    const api = createSteadyFetch({
      ...base,
      fetch,
      headers: { "x-a": "client", "x-b": "client" },
      requestIdHeader: "x-request-id",
    });
    await api.get("/x", { headers: { "X-A": "request" }, requestId: "req-1" });
    const h = new Headers(fetch.calls[0]!.init.headers);
    expect(h.get("x-a")).toBe("request");
    expect(h.get("x-b")).toBe("client");
    expect(h.get("x-request-id")).toBe("req-1");
  });

  it("json option sets content-type, rejects body+json, and GET with body", async () => {
    const fetch = mockFetch(res(200));
    const api = createSteadyFetch({ ...base, fetch });
    await api.post("/x", undefined, { json: { a: 1 } });
    expect(fetch.calls[0]!.init.body).toBe('{"a":1}');
    expect(new Headers(fetch.calls[0]!.init.headers).get("content-type")).toBe("application/json");
    await expect(api.post("/x", "s", { json: {} })).rejects.toBeInstanceOf(ConfigurationError);
    await expect(api.fetch("/x", { body: "s" })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("rejects unsafe request ids (log injection)", async () => {
    const api = createSteadyFetch({ ...base, fetch: mockFetch(res(200)) });
    await expect(api.get("/x", { requestId: "a\nb" })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("close() aborts queued/in-flight requests and rejects new ones", async () => {
    const api = createSteadyFetch({
      baseURL: "https://api.test",
      concurrency: { limit: 1 },
      retry: false,
      timeout: false,
      fetch: mockFetch(hang),
    });
    const a = rejected(api.get("/1"), 10);
    const b = rejected(api.get("/2"), 10);
    api.close();
    for (const e of [await a, await b])
      expect(e).toMatchObject({ code: "REQUEST_ABORTED", reason: "client-closed" });
    await expect(api.get("/3")).rejects.toBeInstanceOf(ConfigurationError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("extend() merges headers and retry, and shares limiters", async () => {
    const fetch = mockFetch(res(200));
    const api = createSteadyFetch({
      ...base,
      fetch,
      headers: { a: "1" },
      concurrency: { limit: 1 },
    });
    const child = api.extend({ headers: { b: "2" }, retry: { maxAttempts: 5 } });
    await child.get("/x");
    const h = new Headers(fetch.calls[0]!.init.headers);
    expect([h.get("a"), h.get("b")]).toEqual(["1", "2"]);
    expect(api.extend({ retry: false })).toBeDefined();
  });

  it("validates configuration eagerly", () => {
    for (const opts of [
      { timeout: -1 },
      { totalTimeout: 0 },
      { concurrency: { limit: 0 } },
      { rateLimit: { limit: 1, intervalMs: 0 } },
      { baseURL: "nope" },
      { retry: { maxAttempts: 0 } },
    ]) {
      expect(() => createSteadyFetch(opts as never)).toThrow(ConfigurationError);
    }
  });

  it("fails clearly when no fetch exists", async () => {
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(createSteadyFetch({ baseURL: "https://a.test" }).get("/x")).rejects.toThrow(
        /fetch implementation/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("origin enforcement", () => {
  it("rejects absolute URLs to other origins before touching the network", async () => {
    const fetch = mockFetch(res(200));
    const api = createSteadyFetch({ ...base, fetch });
    for (const target of ["https://evil.test/x", "//evil.test/x", "http://api.test/x"]) {
      expect(await rejected(api.get(target))).toBeInstanceOf(OriginNotAllowedError);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("allows listed origins", async () => {
    const api = createSteadyFetch({
      ...base,
      allowedOrigins: ["https://cdn.test"],
      fetch: mockFetch(res(200)),
    });
    expect((await api.get("https://cdn.test/a")).status).toBe(200);
  });

  it("detects (but cannot prevent) redirects to disallowed origins", async () => {
    const redirected = () => {
      const r = res(200);
      Object.defineProperty(r, "redirected", { value: true });
      Object.defineProperty(r, "url", { value: "https://evil.test/landing?token=zzz" });
      return r;
    };
    const api = createSteadyFetch({ ...base, fetch: mockFetch(redirected) });
    const err = await rejected(api.get("/x"));
    expect(err).toBeInstanceOf(OriginNotAllowedError);
    expect(err.message).toMatch(/already sent/);
    expect(JSON.stringify(err)).not.toContain("zzz");
  });
});

describe("json()", () => {
  const api = (r: Response) => createSteadyFetch({ ...base, fetch: mockFetch(r) });
  const jsonRes = (body: string, status = 200, ct = "application/json") =>
    res(status, body, { "content-type": ct });

  it("returns typed data together with the response", async () => {
    const { data, response } = await api(jsonRes('{"id":1}')).json<{ id: number }>("/x");
    expect(data.id).toBe(1);
    expect(response.status).toBe(200);
  });
  it("sets Accept by default", async () => {
    const fetch = mockFetch(jsonRes("{}"));
    await createSteadyFetch({ ...base, fetch }).json("/x");
    expect(new Headers(fetch.calls[0]!.init.headers).get("accept")).toBe("application/json");
  });
  it.each([
    ["malformed", jsonRes("{nope")],
    ["empty/204", res(204)],
    ["wrong content type", jsonRes("{}", 200, "text/html")],
  ])("throws ParseError for %s without leaking the body", async (_n, r) => {
    const err = await api(r)
      .json("/x")
      .catch((e: Error) => e);
    expect(err).toMatchObject({ code: "RESPONSE_PARSE_ERROR", status: r.status });
    expect((err as Error).message).not.toContain("nope");
  });
  it("enforces maxResponseBytes without buffering the whole body", async () => {
    const err = await api(jsonRes(JSON.stringify({ a: "x".repeat(5000) })))
      .json("/x", { maxResponseBytes: 100 })
      .catch((e: Error) => e);
    expect(err).toMatchObject({ code: "RESPONSE_PARSE_ERROR" });
    expect((err as Error).message).toMatch(/maxResponseBytes/);
  });
  it("accepts +json media types", async () => {
    const { data } = await api(
      jsonRes('{"a":1}', 200, "application/problem+json; charset=utf-8"),
    ).json<{ a: number }>("/x");
    expect(data.a).toBe(1);
  });
});
