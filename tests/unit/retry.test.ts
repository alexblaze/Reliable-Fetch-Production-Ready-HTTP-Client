import { describe, expect, it } from "vitest";
import { computeBackoff } from "../../src/retry/backoff.js";
import { parseRetryAfter } from "../../src/retry/retryAfter.js";
import { decideRetry, isDefaultEligible, type DecideInput } from "../../src/retry/retryPolicy.js";
import { resolveRetry } from "../../src/client.js";
import { ConfigurationError } from "../../src/index.js";

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter("5")).toBe(5000);
  });
  it("parses HTTP-date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
  });
  it("returns 0 for dates in the past", () => {
    expect(
      parseRetryAfter("Wed, 31 Dec 2025 00:00:00 GMT", Date.parse("2026-01-01T00:00:00Z")),
    ).toBe(0);
  });
  it.each(["", "  ", "abc", "-5", "1.5", "5.5", null, undefined, "Infinity"])("rejects %j", (v) => {
    expect(parseRetryAfter(v as string | null | undefined)).toBeUndefined();
  });
});

describe("computeBackoff", () => {
  const o = { backoff: "exponential" as const, baseDelayMs: 100, maxDelayMs: 1000, jitter: false };
  it("doubles and caps", () => {
    expect([0, 1, 2, 3, 4, 10].map((i) => computeBackoff(i, o))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
  });
  it("fixed ignores the retry index", () => {
    expect(computeBackoff(5, { ...o, backoff: "fixed" })).toBe(100);
  });
  it("does not overflow for absurd retry indexes", () => {
    expect(computeBackoff(10_000, o)).toBe(1000);
  });
  it("jitter stays within [delay/2, delay]", () => {
    const j = { ...o, jitter: true };
    expect(computeBackoff(1, j, () => 0)).toBe(100);
    expect(computeBackoff(1, j, () => 0.999999)).toBeLessThanOrEqual(200);
    for (let i = 0; i < 200; i++) {
      const d = computeBackoff(2, j);
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(400);
    }
  });
});

describe("resolveRetry / eligibility", () => {
  it("is disabled by default and only idempotent-safe methods are listed", () => {
    const p = resolveRetry(undefined, undefined);
    expect(p.maxAttempts).toBe(1);
    expect([...p.methods].sort()).toEqual(["GET", "HEAD", "OPTIONS"]);
  });
  it("never retries POST or PATCH unless explicitly listed", () => {
    const p = resolveRetry({ maxAttempts: 3 }, undefined);
    for (const m of ["POST", "PATCH"])
      expect(isDefaultEligible(p, m, { type: "status", status: 503 })).toBe(false);
    const opt = resolveRetry({ maxAttempts: 3, methods: ["post"] }, undefined);
    expect(isDefaultEligible(opt, "POST", { type: "status", status: 503 })).toBe(true);
  });
  it("does not retry arbitrary 4xx", () => {
    const p = resolveRetry({ maxAttempts: 3 }, undefined);
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isDefaultEligible(p, "GET", { type: "status", status })).toBe(false);
    }
  });
  it("request-level false disables, request-level options merge", () => {
    expect(resolveRetry({ maxAttempts: 5 }, false).maxAttempts).toBe(1);
    expect(resolveRetry(false, undefined).maxAttempts).toBe(1);
    const m = resolveRetry({ maxAttempts: 5, baseDelayMs: 10 }, { maxAttempts: 2 });
    expect(m.maxAttempts).toBe(2);
    expect(m.baseDelayMs).toBe(10);
  });
  it.each([
    { maxAttempts: 0 },
    { maxAttempts: 1.5 },
    { maxAttempts: 1000 },
    { baseDelayMs: -1 },
    { backoff: "x" as never },
    { statusCodes: [99] },
  ])("rejects invalid %j", (opts) =>
    expect(() => resolveRetry(opts, undefined)).toThrow(ConfigurationError),
  );
});

describe("decideRetry", () => {
  const policy = resolveRetry(
    { maxAttempts: 3, jitter: false, baseDelayMs: 100, maxDelayMs: 1000 },
    undefined,
  );
  const base: DecideInput = {
    policy,
    eligible: true,
    attempt: 1,
    failure: { type: "status", status: 503 },
    replayable: true,
    totalDelayMs: 0,
    remainingMs: undefined,
  };
  it("retries with backoff", () =>
    expect(decideRetry(base)).toEqual({ retry: true, delayMs: 100 }));
  it("counts the initial request: maxAttempts=3 means 2 retries", () => {
    expect(decideRetry({ ...base, attempt: 2 })).toEqual({ retry: true, delayMs: 200 });
    expect(decideRetry({ ...base, attempt: 3 })).toEqual({ retry: false, reason: "max-attempts" });
  });
  it("is not eligible when disabled", () => {
    const off = resolveRetry(undefined, undefined);
    expect(decideRetry({ ...base, policy: off })).toEqual({ retry: false, reason: "not-eligible" });
    expect(decideRetry({ ...base, eligible: false })).toEqual({
      retry: false,
      reason: "not-eligible",
    });
  });
  it("honours Retry-After on 429/503 but not other statuses", () => {
    const f = (status: number) => ({ type: "status" as const, status, retryAfter: "2" });
    expect(decideRetry({ ...base, failure: f(429) })).toEqual({ retry: true, delayMs: 2000 });
    expect(decideRetry({ ...base, failure: f(503) })).toEqual({ retry: true, delayMs: 2000 });
    expect(decideRetry({ ...base, failure: f(500) })).toEqual({ retry: true, delayMs: 100 });
  });
  it("refuses absurd Retry-After instead of sleeping", () => {
    const failure = { type: "status" as const, status: 429, retryAfter: "999999999" };
    expect(decideRetry({ ...base, failure })).toEqual({
      retry: false,
      reason: "retry-after-too-long",
    });
  });
  it("ignores an invalid Retry-After", () => {
    const failure = { type: "status" as const, status: 429, retryAfter: "soon" };
    expect(decideRetry({ ...base, failure })).toEqual({ retry: true, delayMs: 100 });
  });
  it("enforces the cumulative delay budget", () => {
    const p = resolveRetry(
      { maxAttempts: 5, jitter: false, maxTotalDelayMs: 250, baseDelayMs: 100 },
      undefined,
    );
    expect(decideRetry({ ...base, policy: p, totalDelayMs: 200 })).toEqual({
      retry: false,
      reason: "budget",
    });
  });
  it("does not retry when the delay would cross the total deadline", () => {
    expect(decideRetry({ ...base, remainingMs: 100 })).toEqual({
      retry: false,
      reason: "deadline",
    });
    expect(decideRetry({ ...base, remainingMs: 101 })).toEqual({ retry: true, delayMs: 100 });
    expect(decideRetry({ ...base, remainingMs: -5 })).toEqual({ retry: false, reason: "deadline" });
  });
  it("refuses non-replayable bodies", () => {
    expect(decideRetry({ ...base, replayable: false })).toEqual({
      retry: false,
      reason: "body-not-replayable",
    });
  });
});
