import { useEffect, useState } from "react";
import { createSteadyFetch, isSteadyFetchError } from "steadyfetch";

const api = createSteadyFetch({ baseURL: "https://api.example.com", retry: { maxAttempts: 3 } });

type State<T> =
  { status: "loading" } | { status: "ok"; data: T } | { status: "error"; code: string };

/** Aborts the request on unmount/path change; AbortError is not treated as a failure. */
export function useJson<T>(path: string): State<T> {
  const [state, setState] = useState<State<T>>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    api
      .json<T>(path, { signal: controller.signal })
      .then(({ data }) => setState({ status: "ok", data }))
      .catch((error: unknown) => {
        if (isSteadyFetchError(error) && error.code === "REQUEST_ABORTED") return;
        setState({ status: "error", code: isSteadyFetchError(error) ? error.code : "UNKNOWN" });
      });
    return () => controller.abort();
  }, [path]);
  return state;
}

export function Users() {
  const state = useJson<Array<{ id: number; name: string }>>("/users");
  if (state.status === "loading") return <p>Loading…</p>;
  if (state.status === "error") return <p>Failed: {state.code}</p>;
  return (
    <ul>
      {state.data.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}
