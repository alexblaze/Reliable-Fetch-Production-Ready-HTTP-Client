// In your project: import { createSteadyFetch } from "steadyfetch";
import {
  createSteadyFetch,
  HttpError,
  RetryExhaustedError,
  TimeoutError,
  isSteadyFetchError,
} from "steadyfetch";

const api = createSteadyFetch({
  baseURL: "https://api.example.com/v1",
  timeout: 10_000, // per attempt, until response headers arrive
  totalTimeout: 30_000, // whole operation including queueing and retry delays
  retry: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5_000 }, // GET/HEAD/OPTIONS only
  concurrency: { limit: 5 },
  rateLimit: { limit: 20, intervalMs: 1_000 },
  headers: { authorization: `Bearer ${process.env.API_TOKEN ?? ""}` },
  onEvent: (event) => {
    // Events are redacted: no headers, bodies or sensitive query values.
    if (event.type === "request:end") console.log(event.outcome, event.attempts, event.durationMs);
  },
});

interface User {
  id: number;
  name: string;
}

export async function listUsers(signal?: AbortSignal): Promise<User[]> {
  try {
    const { data, response } = await api.json<User[]>("/users", signal ? { signal } : {});
    console.log("status", response.status, "etag", response.headers.get("etag"));
    return data;
  } catch (error) {
    if (error instanceof HttpError) console.error("server said", error.status);
    else if (error instanceof RetryExhaustedError) console.error("gave up:", error.reason);
    else if (error instanceof TimeoutError) console.error("timed out in phase", error.phase);
    else if (isSteadyFetchError(error)) console.error(error.code);
    throw error;
  }
}
