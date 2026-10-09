import { randomUUID } from "node:crypto";
import { createSteadyFetch } from "steadyfetch";

const api = createSteadyFetch({ baseURL: "https://api.example.com" });

// POST is never retried by default. Opt in ONLY if the server honours Idempotency-Key.
export async function createOrder(order: unknown) {
  const key = randomUUID(); // generated once, reused by every attempt
  return api.post("/orders", undefined, {
    json: order,
    headers: { "idempotency-key": key },
    retry: { maxAttempts: 3, methods: ["POST"] },
  });
}

// Streaming uploads are only retryable through a body factory.
export function upload(makeStream: () => ReadableStream<Uint8Array>) {
  return api.put("/files/1", makeStream, { retry: { maxAttempts: 3, methods: ["PUT"] } });
}
