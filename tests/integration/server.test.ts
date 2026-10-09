import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HttpError,
  NetworkError,
  OriginNotAllowedError,
  TimeoutError,
  createSteadyFetch,
} from "../../src/index.js";
import { json, startServer, type TestServer } from "../helpers/server.js";

let server: TestServer;
let other: TestServer;
let concurrent = 0;
let maxConcurrent = 0;
let flaky = 0;

beforeAll(async () => {
  other = await startServer((_req, res) => json(res, 200, { from: "other" }));
  server = await startServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    switch (url.pathname) {
      case "/json":
        return json(res, 200, { hello: "world" });
      case "/text":
        res.writeHead(200, { "content-type": "text/plain" });
        return void res.end("plain");
      case "/empty":
        res.writeHead(204);
        return void res.end();
      case "/missing":
        return json(res, 404, { error: "nope" });
      case "/bad-json":
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end("{oops");
      case "/echo": {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return json(res, 200, {
          method: req.method,
          body: Buffer.concat(chunks).toString(),
          ct: req.headers["content-type"],
        });
      }
      case "/slow":
        await new Promise((r) => setTimeout(r, 400));
        return json(res, 200, {});
      case "/reset":
        return void req.socket.destroy();
      case "/flaky": {
        flaky++;
        if (flaky % 3 !== 0) return json(res, 503, {}, { "retry-after": "0" });
        return json(res, 200, { attempt: flaky });
      }
      case "/limited":
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
        return json(res, 200, {});
      case "/redirect-same":
        res.writeHead(302, { location: "/json" });
        return void res.end();
      case "/redirect-out":
        res.writeHead(302, { location: `${other.url}/x` });
        return void res.end();
      case "/stream":
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("one,");
        await new Promise((r) => setTimeout(r, 20));
        return void res.end("two");
      default:
        return json(res, 500, {});
    }
  });
});
afterAll(async () => {
  await server.close();
  await other.close();
});

const client = (extra = {}) => createSteadyFetch({ baseURL: server.url, ...extra });

describe("against a real HTTP server", () => {
  it("json(), text and 204", async () => {
    const api = client();
    expect((await api.json<{ hello: string }>("/json")).data.hello).toBe("world");
    expect(await (await api.get("/text")).text()).toBe("plain");
    const empty = await api.get("/empty");
    expect(empty.status).toBe(204);
    await expect(api.json("/empty")).rejects.toMatchObject({ code: "RESPONSE_PARSE_ERROR" });
  });

  it("throws HttpError for 404 with the unconsumed body available", async () => {
    const err = (await client()
      .get("/missing")
      .catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(await err.response?.json()).toEqual({ error: "nope" });
  });

  it("surfaces malformed JSON as ParseError", async () => {
    await expect(client().json("/bad-json")).rejects.toMatchObject({
      code: "RESPONSE_PARSE_ERROR",
    });
  });

  it("sends bodies and json", async () => {
    const api = client();
    const a = await (
      await api.post("/echo", "raw", { headers: { "content-type": "text/x" } })
    ).json();
    expect(a).toEqual({ method: "POST", body: "raw", ct: "text/x" });
    const b = await (await api.put("/echo", undefined, { json: { n: 1 } })).json();
    expect(b).toEqual({ method: "PUT", body: '{"n":1}', ct: "application/json" });
  });

  it("maps connection resets to NetworkError", async () => {
    const err = await client({ retry: false })
      .get("/reset")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(JSON.stringify(err)).not.toMatch(/ECONNRESET|socket|fetch failed/); // cause reduced to its class name
  });

  it("times out slow servers", async () => {
    const err = await client({ timeout: 50 })
      .get("/slow")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it("retries a flaky endpoint to success", async () => {
    flaky = 0;
    const api = client({ retry: { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 20 } });
    const { data } = await api.json<{ attempt: number }>("/flaky");
    expect(data.attempt).toBe(3);
  });

  it("enforces the concurrency limit on the wire", async () => {
    maxConcurrent = 0;
    const api = client({ concurrency: { limit: 3 } });
    await Promise.all(Array.from({ length: 15 }, () => api.get("/limited")));
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("follows same-origin redirects", async () => {
    expect((await client().json<{ hello: string }>("/redirect-same")).data.hello).toBe("world");
  });

  it("flags cross-origin redirects after the fact, and redirect:'error' prevents them", async () => {
    await expect(client().get("/redirect-out")).rejects.toBeInstanceOf(OriginNotAllowedError);
    const before = other.hits;
    await expect(client().get("/redirect-out", { redirect: "error" })).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(other.hits).toBe(before); // never contacted
    // an explicit allow-list lets it through
    const ok = await client({ allowedOrigins: [other.url] }).get("/redirect-out");
    expect(ok.status).toBe(200);
  });

  it("streams response bodies untouched", async () => {
    const res = await client().get("/stream");
    const chunks: string[] = [];
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>)
      chunks.push(new TextDecoder().decode(c));
    expect(chunks.join("")).toBe("one,two");
  });

  it("caller abort cancels reading a streaming body", async () => {
    const c = new AbortController();
    const res = await client().get("/stream", { signal: c.signal });
    c.abort();
    await expect(res.text()).rejects.toBeDefined();
  });
});
