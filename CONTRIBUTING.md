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
the Linux x64 release artifact on the full live harness report validator
and the discovery live smoke as co-gates.

## Project shape

- **`src/surface/`** — **L2 contract authority.** Each dual-surface (or
  declared exception) operation lives here as a `SurfaceOperationContract`
  on `SURFACE_OPERATIONS` (`src/surface/index.ts`): CLI command, MCP tool,
  safety/confirm, live steps, adapters. Public inventories
  (`CLI_SURFACE_MANIFEST` / `MCP_SURFACE_MANIFEST`) and live coverage are
  **derived** from this list — extend surface ops rather than hand-editing
  tool name inventories.
- **`src/lib/`** — core library functions (Linear I/O, cache, encode). No
  `console.*`, no `process.exit`. Throw `LebopError` (or a subtype) for
  structured errors. Consumed by surface execute paths and thin adapters.
- **`src/commands/`** — thin CLI shells: parse argv, call surface/lib,
  format output (agent-default machine TOON). Prefer surface `fromCli` +
  `execute*`.
- **`src/mcp/`** — thin MCP registration: `mcpToolConfig(operation, schema)`
  + surface `fromMcp`/`execute*`. Profile filter (core vs full) is derived
  from surface core tags.
- **`tests/`** — vitest unit/integration tests. Mock at `src/lib/sdk.ts` for
  network-touching code paths. Use `bun run test` (not bare `bun test`).

See `docs/spec.md` for the full architecture.

## Agent skills (`agents/skills/`)

Six isolated verticals: `cli/{lebop,lebop-program,lebop-execution}` and
`mcp/{lebop,lebop-program,lebop-execution}` → install names `lebop-cli*`,
`lebop-mcp*`. Rules:

- **Complete `SKILL.md` only** — no `references/` trees.
- **No cross-skill links** or peer install-name routing; each skill is self-contained.
- **Medium purity:** CLI skills teach shell; MCP skills teach tools (no dual inventory dump).
- Frontmatter `name:` must match `bin/install-claude` install map.
- When adding an MCP tool, update `MCP_REGISTRATION_ORDER_LOCK` in
  `src/mcp/tools/index.ts` (order-only secondary list; presence stays surface-derived).

`bun run check:package` and `tests/installClaude.test.ts` enforce skill count and isolation.

## Testing against Linear

Most of lebop's correctness depends on Linear's GraphQL surface. **Live
integration tests must run against a sandbox workspace/team** — never modify
real Linear data during development.

Project-only fixtures are not enough for the current surface: live coverage
touches labels, projects, initiatives, milestones, documents, cycles, agent
sessions, publish/cache flows, destructive cleanup, and MCP calls. Use a
dedicated workspace/team boundary like the **lebop-playground / LEB** sandbox
(CI secret `LEBOP_SANDBOX_TOKEN`), and keep that discipline when adding new
GraphQL paths. Maintainers run `scripts/live-surface-smoke.mjs` (full
surface) and `scripts/live-discovery-smoke.mjs` (discovery/features); both
honor `LEBOP_LIVE_BIN` for compiled-binary provenance.

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
