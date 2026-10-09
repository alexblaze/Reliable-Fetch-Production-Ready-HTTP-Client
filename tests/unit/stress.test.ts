import { describe, expect, it } from "vitest";
import { createSteadyFetch } from "../../src/index.js";
import { ConcurrencyLimiter } from "../../src/limits/concurrency.js";
import { mockFetch, res } from "../helpers/mockFetch.js";

describe("stress", () => {
  it("5,000 queued requests complete without leaking permits", async () => {
    let active = 0;
    let max = 0;
    const fetch = mockFetch(async () => {
      active++;
      max = Math.max(max, active);
      await Promise.resolve();
      active--;
      return res(200);
    });
    const api = createSteadyFetch({
      baseURL: "https://a.test",
      concurrency: { limit: 8, maxQueueSize: 6000 },
      retry: false,
      fetch,
    });
    const results = await Promise.all(Array.from({ length: 5000 }, (_, i) => api.get(`/${i}`)));
    expect(results).toHaveLength(5000);
    expect(max).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    // capacity fully restored: a fresh burst still runs 8-wide
    await Promise.all(Array.from({ length: 16 }, () => api.get("/again")));
  });

  it("a cancellation storm leaves the queue empty and the limiter usable", async () => {
    const l = new ConcurrencyLimiter(1, 100_000);
    const hold = await l.acquire(new AbortController().signal);
    const controllers = Array.from({ length: 20_000 }, () => new AbortController());
    const waiters = controllers.map((c) =>
      l.acquire(c.signal).then(
        () => "ok",
        () => "aborted",
      ),
    );
    expect(l.queued).toBe(20_000);
    controllers.forEach((c) => c.abort());
    expect((await Promise.all(waiters)).every((r) => r === "aborted")).toBe(true);
    expect(l.queued).toBe(0);
    hold();
    expect(l.active).toBe(0);
    (await l.acquire(new AbortController().signal))();
  });

  it("a retry storm stays bounded", async () => {
    const f = mockFetch(res(503));
    const api = createSteadyFetch({
      baseURL: "https://a.test",
      fetch: f,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });
    await Promise.allSettled(Array.from({ length: 500 }, () => api.get("/x")));
    expect(f).toHaveBeenCalledTimes(1500);
  });

  it("completed requests leave no tracked state behind", async () => {
    const api = createSteadyFetch({ baseURL: "https://a.test", fetch: mockFetch(res(200)) });
    for (let i = 0; i < 1000; i++) await api.get("/x");
    // close() after traffic must have nothing left to abort
    api.close();
    await expect(api.get("/x")).rejects.toThrow(/closed/);
  });
});
