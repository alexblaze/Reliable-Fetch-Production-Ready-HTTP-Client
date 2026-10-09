import { createSteadyFetch } from "steadyfetch";

// Browser notes: CORS/CSP still apply, credentials are NOT sent cross-origin unless you
// ask for them, and anything shipped to the browser is visible to users (no server secrets).
const api = createSteadyFetch({
  baseURL: "https://api.example.com",
  timeout: 8_000,
  retry: { maxAttempts: 2 },
});

const controller = new AbortController();
document.querySelector("#cancel")?.addEventListener("click", () => controller.abort());

api
  .json<{ message: string }>("/hello", { signal: controller.signal, credentials: "same-origin" })
  .then(({ data }) => {
    document.querySelector("#out")!.textContent = data.message;
  })
  .catch((error: unknown) => console.warn((error as { code?: string }).code ?? "unknown"));
