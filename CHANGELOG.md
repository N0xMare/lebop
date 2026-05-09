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

- **CLI**: 33 top-level commands covering discovery (`list`, `mine`,
  `projects`, `teams`), lifecycle (`show`, `pull`, `push`, `status`,
  `diff`, `lint`), taxonomy + PM CRUD (`set`, `comment`, `label`,
  `milestone`, `project`, `project-update`, `initiative`,
  `initiative-update`, `cycle`, `document`, `agent-session`, `team`,
  `link`, `new`, `archive`, `unarchive`, `relation`), declarative
  authoring (`plan`), plus `auth`, `raw`, `mcp`, `schema`,
  `completions`. See `docs/spec.md` §8.
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
- **One-liner installer** at `scripts/install.sh`: detects OS+arch,
  fetches the matching binary from the GitHub release, verifies SHA256,
  installs to `~/.local/bin` or `/usr/local/bin`. Honors
  `LEBOP_VERSION`, `LEBOP_INSTALL_DIR`, `LEBOP_REPO`.
- **CI + release automation**: `.github/workflows/ci.yml` (biome → tsc
  → vitest on push/PR) and `.github/workflows/release.yml` (tag-
  triggered, 4-platform `bun build --compile`, attached to release with
  `SHA256SUMS`).
- **OSS hygiene baseline**: `LICENSE` (MIT), `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), issue
  + PR templates, `package.json` publish fields, README badges.
- **241 tests** passing under both `bun test` and `vitest run`.

### Documentation

- Single source of truth in `docs/spec.md` covering identity, setup,
  architecture, full CLI reference, plan workflow, lint rules, MCP
  server, Linear API facts, discovered quirks, roadmap.
- README with quick start + verb mental model.
- `claude/skills/lebop/SKILL.md` + slash commands for Claude Code agents.

### Fixed

- **Multi-workspace `default_team` leakage**: a global `default_team`
  config entry would apply across every Linear workspace, breaking
  commands like `projects` / `list` / `set` / `push` whenever the active
  workspace didn't have a team with that key. New
  `workspace_team_defaults: { <slug>: <KEY> }` field in
  `~/.lebop/config.yaml` resolves the team per active workspace; legacy
  `default_team` still works as the global fallback. Active workspace
  resolves from `LEBOP_WORKSPACE` env (set by `--workspace`) or the auth
  file's stored default.

### Removed

- **`lebop help-search`** — Linear no longer exposes the
  `searchDocumentation` GraphQL field this command wrapped, so every
  invocation errored. Removed cleanly; no replacement needed (Linear's
  product help search lives outside the public API). Use `lebop raw` if
  you need to query a similar field after Linear restores one.

### Known limitations (deliberate, deferred)

- File attachment (`lebop attach <issue> <file>`) — needs Linear's
  pre-signed S3 upload flow; `raw` covers the underlying mutations.
- `issue start` / `pr` / browser-open shortcuts — pair with
  `@schpet/linear-cli` for these interactive ergonomics.
- Comment edit/delete on cached comments — comments are read-only in the
  cache; mutate via `lebop comment update <comment-id>` direct command.
- App-actor OAuth — deferred until audit-trail noise is observable.
- MCP HTTP+SSE transport — stdio only at first release.
