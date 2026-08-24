# Contributing to opencode-remote

Thanks for helping improve remote agent orchestration!

## Development setup

Requirements: **Node.js >= 22** (tests use the native `node:test` runner with TypeScript
type-stripping) and npm. No SSH access or remote hosts needed — the entire test suite is
pure command construction and output parsing.

```sh
git clone https://github.com/oke3/opencode-remote.git
cd opencode-remote
npm install
npm test
```

## Before you open a PR

Run the full gate — all four must pass:

```sh
npm run typecheck   # strict tsc
npm test            # 108+ cases
npm run build       # dist/ must emit cleanly
npm run smoke       # dist/cli.js --help exits 0
```

## Guidelines

- **Zero runtime dependencies.** devDependencies limited to `typescript` + `@types/node`.
- **Pure functions for anything constructible.** Command builders, parsers, templates are pure
  and unit-tested; side effects live only in thin CLI wrappers.
- **No network in tests.** Serve-client tests inject a fetch implementation.
- **Precise errors.** Name the exact bad input and why; usage errors exit `2`.
- Host names must match `[A-Za-z0-9._-]+` — anything else is rejected before ssh sees it.
- Windows-first, but keep `ssh.ts` host-agnostic so POSIX remotes can slot in later.

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Code of conduct

Be direct, be kind, no drama.
