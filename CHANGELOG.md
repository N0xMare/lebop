# Changelog

All notable changes to lebop are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning ramps to `1.0.0` only when the public-release roadmap in
`docs/spec.md` §13 is complete; everything before that lives on `0.x`.

## [Unreleased]

The pre-public-release work is captured here. When the first public tag
ships (`v1.0.0`), this section will be moved into a versioned entry below.

### Added

- **CLI**: 33 top-level commands across discovery, lifecycle, taxonomy
  CRUD, PM surface, plus `plan`, `lint`, `raw`, `mcp`, `schema`,
  `help-search`. See `docs/spec.md` §8.
- **MCP server** (`lebop mcp`): 41 tools wrapping the same lib core
  exposed by the CLI. stdio transport. Per-tool `workspace` arg + sticky-
  state-safe env restoration via `safe()` decorator. `LebopError` `code`
  + `hint` preserved through MCP tool error responses.
- **Multi-workspace auth**: `~/.lebop/auth.json` schema v2 supports N
  workspaces with optional default. v1 files auto-migrate on first read.
  `lebop auth list/default/token/whoami/logout` accept a slug arg;
  `--workspace` flag propagates via `LEBOP_WORKSPACE` env.
- **Pull → edit → push loop** with CAS via `updatedAt`, lint pre-mutation,
  cursor pagination across all list operations, retry + rate-limit at the
  SDK boundary, structured error taxonomy (`LebopError` + 6 subtypes).
- **Declarative `plan apply`**: directory of frontmatter-markdown files
  realized as a Linear project + issues + relations in one idempotent
  pass. `plan validate / apply / diff / pull / lint`.
- **Linter** with universal Linear-renderer rules (L001–L006) + repo-
  scoped rules (L004, R001, R002).
- **Cache + diff** with field-level diffing against `_server` snapshot;
  `lebop status` shows modified / clean / stale (remote-newer) sections.
- **Shell completions** (`lebop completions <bash|zsh|fish>`) emitting
  scripts that complete top-level subcommands.
- **241 tests** passing under both `bun test` and `vitest run`.

### Documentation

- Single source of truth in `docs/spec.md` covering identity, setup,
  architecture, full CLI reference, plan workflow, lint rules, MCP
  server, Linear API facts, discovered quirks, roadmap.
- README with quick start + verb mental model.
- `claude/skills/lebop/SKILL.md` + slash commands for Claude Code agents.

### Known limitations (deliberate, deferred)

- File attachment (`lebop attach <issue> <file>`) — needs Linear's
  pre-signed S3 upload flow; `raw` covers the underlying mutations.
- `issue start` / `pr` / browser-open shortcuts — pair with
  `@schpet/linear-cli` for these interactive ergonomics.
- Comment edit/delete on cached comments — comments are read-only in the
  cache; mutate via `lebop comment update <comment-id>` direct command.
- App-actor OAuth — deferred until audit-trail noise is observable.
- MCP HTTP+SSE transport — stdio only at first release.
