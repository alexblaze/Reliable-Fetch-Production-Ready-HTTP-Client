# Security policy

## Supported versions

| Version                  | Supported                |
| ------------------------ | ------------------------ |
| latest 0.x / 1.x release | ✅ security fixes        |
| older releases           | ❌ upgrade to the latest |

Supported Node.js versions follow the [Node.js release schedule](https://github.com/nodejs/release#release-schedule): active LTS and maintenance LTS lines. Support for a Node.js line is dropped in a minor release (pre-1.0) or major release (after 1.0) once it reaches end-of-life.

## Reporting a vulnerability

**Please do not open a public issue for a suspected vulnerability.**

Report privately through GitHub: <https://github.com/alexblaze/Reliable-Fetch-Production-Ready-HTTP-Client/security/advisories/new> ("Report a vulnerability" on the Security tab).

Include:

- affected version(s) and runtime (Node.js version / browser);
- a description of the impact (e.g. secret exposure in events, retry of an unsafe request, origin-policy bypass);
- a minimal reproduction or proof of concept;
- any suggested fix.

## What to expect

These are targets, not guarantees: acknowledgement within 5 business days, an initial assessment within 10 business days, and coordinated disclosure with a fix release and advisory (credit given unless you prefer otherwise). Please give us reasonable time to release a fix before public disclosure.

## Scope

In scope: this package's code and published artifact. Out of scope: vulnerabilities in the JavaScript runtime or in applications using the library, and the documented limitations in [docs/security.md](docs/security.md) (for example, redirect-based SSRF can be detected but not prevented by the library).
