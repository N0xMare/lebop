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
bun run check          # biome lint + format check
bun run typecheck      # TypeScript
bun run test           # vitest (do not use bare `bun test` — that's
                       # Bun's built-in runner, which trips on
                       # vitest-only APIs like vi.resetModules)
bun run check:package  # npm package contents + install-script assumptions
```

Those core gates must be green before opening a PR. CI also verifies GitHub
Actions refs, runs `actionlint`, and builds a compiled binary smoke. If you
have `actionlint` installed locally, run:

```sh
node scripts/check-npm-pack.mjs --workflow-action-refs
actionlint .github/workflows/*.yml
```

Release tags run the same gate, build four Bun-compiled binaries, and gate
the Linux x64 release artifact on the full Noxor live harness report
validator.

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
integration tests must run against a sandbox workspace/team** — never modify
real Linear data during development.

Project-only fixtures are not enough for the current surface: live coverage
touches labels, projects, initiatives, milestones, documents, cycles, agent
sessions, publish/cache flows, destructive cleanup, and MCP calls. Use a
dedicated workspace/team boundary like the NOX/Noxor sandbox described in
`docs/spec.md`, and keep that discipline when adding new GraphQL paths.

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
positioning. Bulk edits, declarative plans, lint, `updatedAt` stale guards,
MCP tools, CLI ergonomics for agent workflows.

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
4. If applicable, `lebop auth whoami --json` and `lebop teams --json`
   output with workspace names, user fields, and secrets redacted

For security-sensitive bugs (token mishandling, etc.), please open a private GitHub Security Advisory at `https://github.com/N0xMare/lebop/security/advisories/new` rather than a public issue.
