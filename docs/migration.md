# Migration & compatibility

steadyfetch follows semantic versioning. **Before 1.0.0 the API may change in minor releases**; every change is recorded in the [CHANGELOG](../CHANGELOG.md) with migration notes here.

Behavioural defaults (retry policy, timeouts, error codes) are treated as part of the public contract: changing them is a breaking change even if the TypeScript types still compile. Deprecations are announced in the CHANGELOG at least one minor release before removal once the package reaches 1.0.

## From native `fetch`

```ts
// before
const res = await fetch(`${base}/users`, { signal });
if (!res.ok) throw new Error(String(res.status));
const users = await res.json();

// after
const { data: users } = await api.json<User[]>("/users", { signal });
```

Differences: non-2xx throws, relative paths need `baseURL`, `Request` objects are not accepted as input, timeouts default to 30 s, and `credentials`/`redirect` are passed through unchanged.

## 0.x → 1.0

Nothing to migrate yet.
