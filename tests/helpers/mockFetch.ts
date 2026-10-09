import { vi } from "vitest";

export type Step =
  Response | Error | ((init: RequestInit, call: number) => Promise<Response> | Response);

export function res(
  status = 200,
  body: BodyInit | null = "ok",
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : body, { status, headers });
}

export function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** A fetch that never resolves but rejects when its signal aborts, like the real thing. */
export const hang: Step = (init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });

export function mockFetch(...steps: Step[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = calls.push({ url: String(url), init });
    const step = steps[Math.min(call - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(init, call);
    // Responses are single-use; clone so the last step can repeat.
    return step.clone();
  });
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

export const networkError = () => new TypeError("fetch failed");
