import { describe, expectTypeOf, it } from "vitest";
import {
  createSteadyFetch,
  type ClientOptions,
  type ErrorCode,
  type JsonResult,
  type RequestOptions,
  type SteadyFetchEvent,
} from "../../src/index.js";

describe("public types", () => {
  const api = createSteadyFetch();

  it("json<T>() infers data while keeping the response", () => {
    expectTypeOf(api.json<{ id: number }>).returns.resolves.toEqualTypeOf<
      JsonResult<{ id: number }>
    >();
    expectTypeOf<JsonResult<string>["response"]>().toEqualTypeOf<Response>();
  });

  it("verbs return native Response", () => {
    expectTypeOf(api.get).returns.resolves.toEqualTypeOf<Response>();
    expectTypeOf(api.post).returns.resolves.toEqualTypeOf<Response>();
  });

  it("rejects invalid option shapes", () => {
    // @ts-expect-error timeout must be number | false
    const a: ClientOptions = { timeout: "10s" };
    // @ts-expect-error unknown backoff strategy
    const b: ClientOptions = { retry: { backoff: "random" } };
    // @ts-expect-error concurrency requires a limit
    const c: ClientOptions = { concurrency: {} };
    // never invoked: only type-checked
    // @ts-expect-error verb helpers own the method
    const misuse = () => api.get("/x", { method: "POST" });
    void [a, b, c, misuse];
  });

  it("accepts body factories and exposes stable error codes", () => {
    const o: RequestOptions = { body: () => new ReadableStream() };
    const code: ErrorCode = "RETRY_EXHAUSTED";
    expectTypeOf(o).toMatchTypeOf<RequestOptions>();
    expectTypeOf(code).toBeString();
  });

  it("discriminates events by type", () => {
    const handle = (e: SteadyFetchEvent) => {
      if (e.type === "retry:scheduled") expectTypeOf(e.delayMs).toBeNumber();
      if (e.type === "request:end") expectTypeOf(e.outcome).toBeString();
    };
    void handle;
  });
});
