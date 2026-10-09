import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "../../src/limits/concurrency.js";
import { RateLimiter } from "../../src/limits/rateLimiter.js";
import { QueueFullError } from "../../src/index.js";
import { WaitAborted } from "../../src/utils/abort.js";

const sig = () => new AbortController();

describe("ConcurrencyLimiter", () => {
  it("limits active permits and serves FIFO", async () => {
    const l = new ConcurrencyLimiter(2, 100);
    const order: number[] = [];
    const a = await l.acquire(sig().signal);
    const b = await l.acquire(sig().signal);
    const pending = [3, 4, 5].map((n) => l.acquire(sig().signal).then((r) => (order.push(n), r)));
    expect(l.active).toBe(2);
    expect(l.queued).toBe(3);
    a();
    const r3 = await pending[0]!;
    expect(order).toEqual([3]);
    b();
    const r4 = await pending[1]!;
    r3();
    const r5 = await pending[2]!;
    expect(order).toEqual([3, 4, 5]);
    r4();
    r5();
    expect(l.active).toBe(0);
  });

  it("release is idempotent (no double decrement)", async () => {
    const l = new ConcurrencyLimiter(1, 10);
    const r = await l.acquire(sig().signal);
    r();
    r();
    r();
    expect(l.active).toBe(0);
    const r2 = await l.acquire(sig().signal);
    const second = l.acquire(sig().signal);
    expect(l.queued).toBe(1); // limit still enforced after repeated releases
    r2();
    (await second)();
  });

  it("cancelled waiters leave the queue and do not consume permits", async () => {
    const l = new ConcurrencyLimiter(1, 10);
    const hold = await l.acquire(sig().signal);
    const c = sig();
    const w = l.acquire(c.signal);
    expect(l.queued).toBe(1);
    c.abort();
    await expect(w).rejects.toBeInstanceOf(WaitAborted);
    expect(l.queued).toBe(0);
    hold();
    expect(l.active).toBe(0);
  });

  it("rejects when already aborted and when the queue is full", async () => {
    const l = new ConcurrencyLimiter(1, 1);
    const c = sig();
    c.abort();
    await expect(l.acquire(c.signal)).rejects.toBeInstanceOf(WaitAborted);
    const hold = await l.acquire(sig().signal);
    void l.acquire(sig().signal);
    await expect(l.acquire(sig().signal)).rejects.toBeInstanceOf(QueueFullError);
    hold();
  });
});

describe("RateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows a burst of `limit` then spaces starts by the window", async () => {
    const l = new RateLimiter(2, 1000, 100);
    const starts: number[] = [];
    const t0 = Date.now();
    const jobs = Array.from({ length: 5 }, () =>
      l.acquire(sig().signal).then(() => starts.push(Date.now() - t0)),
    );
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(jobs);
    expect(starts).toEqual([0, 0, 1000, 1000, 2000]);
  });

  it("cancelled waiters free their place and the timer is cleared", async () => {
    const l = new RateLimiter(1, 1000, 100);
    await l.acquire(sig().signal);
    const c = sig();
    const w = l.acquire(c.signal);
    expect(vi.getTimerCount()).toBe(1);
    c.abort();
    await expect(w).rejects.toBeInstanceOf(WaitAborted);
    expect(l.queued).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds its queue", async () => {
    const l = new RateLimiter(1, 1000, 1);
    await l.acquire(sig().signal);
    const c = sig();
    void l.acquire(c.signal).catch(() => undefined);
    await expect(l.acquire(sig().signal)).rejects.toBeInstanceOf(QueueFullError);
    c.abort();
  });
});
