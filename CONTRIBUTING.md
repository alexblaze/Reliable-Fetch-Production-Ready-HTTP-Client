# Contributing

Thanks for helping! Correctness and safe defaults matter more than feature count.

## Setup

```sh
git clone https://github.com/alexblaze/Reliable-Fetch-Production-Ready-HTTP-Client.git
cd Reliable-Fetch-Production-Ready-HTTP-Client
npm ci            # Node.js >= 20
```

## Commands

| Command                              | Purpose                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `npm run lint` / `npm run format`    | ESLint / Prettier check (`npx prettier --write .` to fix)                    |
| `npm run typecheck`                  | `tsc --noEmit` over src, tests, examples                                     |
| `npm test` / `npm run test:coverage` | Vitest (unit, integration with a local HTTP server, security, stress, types) |
| `npm run build`                      | tsup → `dist/` (ESM, CJS, d.ts)                                              |
| `npm run verify:pack`                | fails if the tarball contains anything outside the allowlist                 |
| `node scripts/smoke-consumer.mjs`    | installs the packed tarball in a temp project (ESM, CJS, TypeScript)         |

## Code style

TypeScript strict mode, no runtime dependencies (adding one needs a written justification in the PR), no `any`, small modules, comments for _why_ not _what_. Tests never call real external services; use the local server (`tests/helpers/server.ts`) or injected `fetch` mocks with fake timers.

## Pull requests

- One focused change per PR with tests; a behavioural change needs a test that fails without it.
- Retry defaults, timeout semantics and error codes are public contract — call out any change and update `CHANGELOG.md` and the docs.
- Never weaken a security requirement to make a test pass.
- Keep README/doc examples accurate (examples under `examples/` are type-checked).
- CI (lint, typecheck, tests on Node 20/22/24, build, pack verification) must pass.

## Commits and releases

Use clear imperative commit messages (Conventional Commits welcome: `fix:`, `feat:`, `docs:`). Releases: update `version` and `CHANGELOG.md`, merge, then push a tag `vX.Y.Z` matching `package.json`; the release workflow verifies, then publishes after environment approval. Maintainers should read the `npm pack --dry-run` output before approving.

## Issues

Use the issue templates. Include Node/browser version, a minimal reproduction and the error `code`. **Report vulnerabilities privately** — see [SECURITY.md](SECURITY.md).
