# Contributing to lebop

Thanks for your interest in lebop. Some ground rules so we can move fast
together.

## Local development

lebop runs on **Bun**, not Node. The `bin/lebop` shebang is
`#!/usr/bin/env bun`, the test runner targets bun, and the release
workflow ships standalone bun-compiled binaries — there is no Node build.
Install Bun (`curl -fsSL https://bun.sh/install | bash`), then:

```sh
bun install
bun run check          # biome (lint + format)
bunx tsc --noEmit      # type-check
bun run test           # vitest (do not use bare `bun test` — that's
                       # Bun's built-in runner, which trips on
                       # vitest-only APIs like vi.resetModules)
```

All four gates must be green before opening a PR. CI runs the same set on
every PR.

## Project shape

- **`src/lib/`** — core library functions. No `console.*`, no
  `process.exit`. Throw `LebopError` (or a subtype) for structured errors.
  This module is consumed by both the CLI and the MCP server.
- **`src/commands/`** — thin shells over `lib/`. Parse argv, call lib,
  format output. Use `withClient` for idempotent reads + idempotent
  updates; use `linear()` directly only for non-idempotent creates +
  archives + deletes (retry-after-success would duplicate or
  spurious-not-found).
- **`src/mcp/`** — MCP server registration. Each tool wraps a `lib/`
  function via the `safe()` decorator (handles error formatting + per-call
  workspace env restore).
- **`tests/`** — vitest unit tests. Mock at `src/lib/sdk.ts` for
  network-touching code paths.

See `docs/spec.md` for the full architecture.

## Testing against Linear

Most of lebop's correctness depends on Linear's GraphQL surface. **Live
integration tests must run against a sandbox project** — never modify real
Linear data during development.

If you don't have a sandbox, create one in a Linear team you own and use
it exclusively for mutation testing. The pattern in `docs/spec.md` §12
(Discovered quirks) reflects facts caught during sandbox-driven testing;
keep this discipline when adding new GraphQL paths.

## Commits + PRs

- Use present-tense subject lines with a scope prefix: `feat:`, `fix:`,
  `docs:`, `refactor:`, `test:`, `chore:`. Match the surrounding history.
- Include a short "why" in the body. The PR description is for the
  surface narrative; commit messages are for archaeologists.
- Bias toward smaller, focused commits over single-commit mega-PRs. The
  `git log --stat -p` output should be readable.
- Don't `--amend` published commits or `--force` pushed branches without
  asking — destructive history rewrites cost reviewers.

## What's in scope vs out

In scope: anything aligned with "best for agents, sufficient for humans"
positioning. Bulk edits, declarative plans, lint, CAS, MCP tools, CLI
ergonomics for agent workflows.

Out of scope: interactive ergonomics that
[`@schpet/linear-cli`](https://github.com/schpet/linear-cli) does well —
`issue start` (state + branch creation), `pr` (gh-cli wrapper), browser-
open shortcuts, jj/git-aware issue inference. lebop pairs with
linear-cli for these flows. See `docs/spec.md` §3.

## Reporting bugs

Open an issue with:

1. lebop version (`lebop --version`) and Bun version (`bun --version`)
2. The exact command you ran (with secrets redacted)
3. The output you got (and what you expected)
4. If applicable, the JSON output of `lebop --version` and `lebop teams
   --json` to confirm auth + connectivity

For security-sensitive bugs (token mishandling, etc.), please open a private GitHub Security Advisory at `https://github.com/N0xMare/lebop/security/advisories/new` rather than a public issue.
