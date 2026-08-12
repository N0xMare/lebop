# lebop

[![ci](https://github.com/N0xMare/lebop/actions/workflows/ci.yml/badge.svg)](https://github.com/N0xMare/lebop/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/N0xMare/lebop?include_prereleases&sort=semver)](https://github.com/N0xMare/lebop/releases/latest)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-fbf0df)](https://bun.sh)

**Agentic Linear tool for external coding harnesses.** One CLI/MCP surface to explore, fetch, edit, review, and publish Linear work—optimized for use by agents (**not** a Linear app-agent/webhook product). Auth is under a linear **personal API key**. Treats Linear issues as markdown files you can edit, diff, and apply the same way you already work with code. Ships as a CLI and an MCP server sharing one library core.

**Docs:** the sole comprehensive public reference is [`docs/spec.md`](docs/spec.md).

**Version:** **0.0.6** — agent-first Linear control plane (machine/TOON default, progressive MCP core 17 / full 104, multi-workspace paths, AXI densified `next[]`, content size policy, reviewed publish).

Two shapes:

- **Ad-hoc ops** — `list`, `show`, `set`, `comment`, `new`, `archive`, pull → edit files → `push`, `diff`, `raw` GraphQL escape hatch.
- **Declarative planning** — author a **Linear project + its issues** (+ relationships) as a directory of markdown files, then `lebop plan apply` realizes the whole graph in Linear in one idempotent pass. (Linear **initiatives** are separate — use `lebop initiative …` / MCP initiative tools.)

---

## Quick start

```sh
# Install (macOS / Linux, x64 / arm64; verifies SHA256 against the release):
curl -fsSL https://raw.githubusercontent.com/N0xMare/lebop/main/scripts/install.sh | bash

# Authenticate with a Linear Personal API Key (Settings → API in Linear):
lebop auth login

# Try it:
lebop teams
lebop list --assignee me --state-type started --limit 10
```

The installer drops a single self-contained binary (no Bun runtime needed) at `~/.local/bin/lebop` if writable, otherwise `/usr/local/bin/lebop` (sudo). Override with `LEBOP_INSTALL_DIR=...`. Pin a specific version with `LEBOP_VERSION=v0.0.6`.

After install, stay current with:

```sh
lebop update --check    # compare installed version to latest GitHub release
lebop update            # download + SHA256-verify + install latest
lebop update --version v0.0.6   # pin a tag
```

`lebop update` only installs **tagged releases** (not unreleased main). If `which lebop` still shows an old binary after update, check PATH order (`~/.local/bin` vs another copy).

**From source** (Bun required):

```sh
git clone https://github.com/N0xMare/lebop && cd lebop
bun install && bun link
mkdir -p "$HOME/.local/bin"
ln -sf "$HOME/.bun/bin/lebop" "$HOME/.local/bin/lebop"
# add ~/.local/bin to PATH if it isn't already (matches the binary installer)
```

Per-user config lives at `~/.lebop/config.yaml`; auth at `~/.lebop/auth.json` (mode 0600). Local cache defaults to `~/.lebop/cache/<workspace-slug>/<repo-hash>/` (and matching `context/<workspace-slug>/…` for fetch dossiers) when a workspace is selected; publish reviews live under `~/.lebop/publish-reviews/`. Commands that target user files (plan writeback, `--to` exports) write where you point them.
Local cache/context is keyed by **workspace slug + repo path hash** (`~/.lebop/cache|context/<workspace-slug>/<repo-hash>/`). Switching `--workspace` / `LEBOP_WORKSPACE` / auth default isolates local state. For MCP hosts, still pin one `LEBOP_WORKSPACE` per project config so agents do not mix orgs by accident.

Full setup, config, and command reference: [`docs/spec.md`](docs/spec.md).

---

## Mental model: pick the right verb for what you want to do

Examples below use a fictional team key **`TEAM`** and issue IDs like **`TEAM-101`**. Replace with your Linear team prefix and real identifiers.

### Discover

```sh
lebop workspace explore /
lebop workspace explore /projects --query "Billing"
lebop workspace fetch /projects/<uuid>   # default depth shallow; add --depth full for nested dossiers
lebop teams
lebop projects [--team KEY | --all-teams] [--state STATE] [--include-archived] [--limit N] [--cursor TOKEN]
lebop list --assignee me --state-type started
lebop list --project "Billing API v2" --label type:feature
```

**Preferred research flow**

- `workspace explore` — ls-style discovery
- `workspace fetch` — bounded local dossier (default depth **shallow**)
- MCP: `explore_linear_workspace` → `fetch_linear_workspace` (same two steps)

**Targets**

- Bare ids (`TEAM-101`) or paths (`/issues/TEAM-101`, `/projects/<uuid>`, …)
- Issue children (e.g. `/issues/TEAM-101/documents`) when the question is scoped
- Collection/team explore paths are discovery-only (`fetchable: false`); concrete project, issue, initiative, document, cycle, milestone, and agent-session paths are fetchable

**Narrowing**

- `--team` / MCP `team`: **only** project, issue, cycle
- Initiatives / documents / milestones / agent sessions: `--kind`, concrete paths, child paths, smaller limits, fetch controls

**Pagination & budgets**

- Explore: `next_cursor` where supported (project/initiative/issue listings, supported child listings, search); `--limit` is page size (search: per kind)
- Non-cursor-backed capped listings return bounded metadata (not “complete”)
- Fetch: `--limit` is per collection / nested parent / relation direction — not a global file budget
- Truncated manifests: follow `continuations` for exact follow-up explore/fetch calls
- Optional `_meta.linear_api`: API budget telemetry (request/complexity/reset) — not pagination completeness

**Fetch controls**

- Depth: default **shallow**; `--depth full` for nested issue dossiers
- Include: omitted → dossier defaults; CLI `--include ""` / MCP `include: []` → root shell only
- Documents + empty include: omits content from markdown/summary/manifest
- CLI: `--include`, `--depth`, `--limit`, `--to` · MCP: same fields on `fetch_linear_workspace`

### Read one issue

```sh
lebop show TEAM-101                 # machine output by default (TOON); no cache write
lebop show TEAM-101 --format json   # compact JSON instead of TOON
lebop show TEAM-101 --content-file ./issue.md  # large bodies: prefer file for agents
```

**Agent-default CLI is machine output** (no `--json` required). Default encoding is **TOON**; use `--format json` or `LEBOP_MACHINE_FORMAT=json` for compact JSON. MCP tool text is always compact JSON. Envelopes use `schema_version: 2`. See [`docs/spec.md`](docs/spec.md) §8.0.

**Maintainer/dev only:** `--human` / `LEBOP_HUMAN=1` prints chalk tables with full bodies (not size-capped). Not part of the agent product path — agents use machine output plus `--content-file` / `--full-content` for large text.

### Edit one field on one issue (fast, no cache round-trip)

```sh
lebop set state TEAM-101 "In Progress"
lebop set priority TEAM-101 urgent                 # name or 0..4
lebop set estimate TEAM-101 3                      # or null to clear
lebop set description TEAM-101 --description-file ./body.md
lebop set project TEAM-101 "Billing API v2"        # or null to detach
lebop set milestone TEAM-101 "Launch Milestone"    # or null to clear
lebop set cycle TEAM-101 "Cycle 12"                # or null to clear
lebop set due-date TEAM-101 2026-09-01             # or null to clear
lebop set labels TEAM-101 +urgent -area:backend    # delta syntax
lebop set assignee TEAM-101 @me
lebop set parent TEAM-101 TEAM-100                 # or null to detach
lebop set links TEAM-101 +blocks:TEAM-102 +related:TEAM-103   # 5 link kinds
lebop comment add TEAM-101 --body "LGTM"
```

Direct point edits write immediately and do not use the local cache `updatedAt`
snapshot. Use `pull` → edit → `push` or reviewed publish when staleness
protection matters.

### Edit a body with cache protection (bulk / multi-line edit loop)

Use this path for multi-line descriptions and concurrency-sensitive body edits (not the greenfield plan path below).

```sh
lebop pull TEAM-101..TEAM-109                       # or space-separated list, or single id
# ... edit files under ~/.lebop/cache/<workspace-slug>/<repo-hash>/issues/TEAM-101/description.md ...
lebop status                                      # git-like: see what's modified
lebop push --dry-run                              # preview mutations
lebop push                                        # apply (updatedAt stale guard; --force --yes to bypass)
lebop publish review --cache TEAM-101             # reviewed cache publish, returns review_id
lebop publish review --cache --all-modified       # review every modified cache row
lebop publish apply <review-id>                   # apply only reviewed cache state
```

`lebop push` runs the linter first — warnings print to stderr, `--strict` blocks. After success the cache stays clean immediately, no `--refresh` needed.
Use `publish review --cache` when an agent/user wants an explicit approve-then-apply step for cache edits.

### Create or archive issues ad-hoc

```sh
lebop new --title "Add usage metering to the public API" \
           --project "Billing API v2" \
           --state Backlog \
           --priority high \
           --estimate 3 \
           --label type:feature \
           --description "Meter request volume per tenant for the /v1 endpoints."

lebop archive TEAM-101 TEAM-102 --yes               # reversible from the Linear UI
```

### Plan a whole project declaratively (greenfield project + issues hero)

Author a **Linear project + its issues** as markdown on disk (not a Linear Initiative — those use the compose path below):

```
plans/billing-api-v2/
├── _project.md            # required: name / team / description / icon / body → Linear project
├── epic.md                # top-level issue (can have sub-issues via `parent:`)
├── design.md              # has `parent: epic` → renders as a sub-issue in Linear
├── impl.md                # same
└── web-ui.md              # links, labels, priorities, estimates
```

Each `*.md` file has YAML frontmatter for structured fields and markdown body for the description:

```markdown
---
title: "Design usage metering API"
state: Backlog
priority: high
estimate: 3                # points (optional)
labels: [type:feature, area:backend]
parent: epic               # slug of another file, or bare TEAM-###
blocks: [impl]             # local slug OR external TEAM-###
related: [TEAM-250]
---

OpenAPI shape, rate windows, and how the web dashboard will read aggregates.
```

Then realize it in Linear:

```sh
lebop plan validate plans/billing-api-v2          # parse + resolve refs; no Linear writes
lebop plan lint     plans/billing-api-v2 --fix    # catch markdown-renderer gotchas first
lebop plan apply    plans/billing-api-v2 --dry-run   # preview
lebop plan apply    plans/billing-api-v2             # create project + issues + links; writes linear_id back
lebop plan apply    plans/billing-api-v2 --force --yes  # bypass stale/missing plan guard after manual review
lebop plan diff     plans/billing-api-v2             # local-vs-remote drift after changes
lebop plan pull     plans/billing-api-v2 --force --yes  # overwrite local with remote
lebop plan pull     plans/billing-api-v2 --include-new  # also import remote-only issues
```

For agent-authored plans, prefer the reviewed publish wrapper:

```sh
lebop publish review --plan plans/billing-api-v2          # validate + lint + diff + dry-run; returns review_id
lebop publish apply  <review-id>                          # refuses if files changed; publishes + verifies
```

Re-apply is idempotent — unchanged files stay unchanged. Existing Linear updates require a fresh `_server.updated_at` snapshot written by `plan pull` or a previous successful apply; use `--force --yes` only after manually reviewing remote state. Parents get created before children (topological). Slug links auto-rewrite to `TEAM-###` once issues exist. Relations (`blocks` / `blocked_by` / `related` / `duplicates` / `duplicated_by`) honor Linear's single-record-per-pair semantics.

See [`docs/spec.md`](docs/spec.md#9-plan-workflow--declarative-authoring) for the full frontmatter schema, apply semantics, and edge cases.

### Compose initiatives (path A — not a second plan root)

There is **no** `_initiative.md` declarative plan. For org-level programs:

1. Research with `workspace explore` / `fetch` (or MCP equivalents).
2. Realize each project graph with `plan` / `publish review --plan` (one plan dir per Linear project).
3. `lebop initiative create …` (if needed) then `lebop initiative add-project <initiative> <project>`.
4. Narrative: `initiative-update` / `project-update` with health.

Agents: prefer reviewed publish over raw `plan apply` when shipping graphs.

### Diff + escape hatch

```sh
lebop diff TEAM-101                                  # unified diff of local cache vs live remote
lebop raw 'query { viewer { id email } }'          # any GraphQL lebop doesn't wrap
echo '{"id":"TEAM-101"}' | lebop raw 'query($id:String!){issue(id:$id){title}}' --variables-json -
# Raw mutations require --allow-mutation plus --yes/--confirm; prefer first-class verbs when they exist.
```

For MCP, the `raw_graphql` tool uses the same safety boundary: GraphQL mutations require `allow_mutation: true` and `confirm: true`.

### Lint local markdown against Linear's renderer

```sh
lebop lint                                       # scans ~/.lebop/cache/<workspace-slug>/<repo-hash>/ by default
lebop lint path/to/some.md --fix                 # explicit paths; --fix applies safe rewrites
lebop lint --strict                              # exit non-zero on warnings (pre-commit gate)
```

Rules catch Linear's markdown landmines (table-cell `1.` breaking rows, `text\n---` silently becoming a setext H2, etc.) plus optional repo-scoped rules (bracketed issue refs, path rewrites, custom regex formats) driven by per-repo config.
With `--fix`, CLI JSON reports remaining post-fix warnings and counts, not stale warnings that were already fixed. For MCP, use `lint_files` for CLI-equivalent path/cache linting, or `lint_text` for arbitrary in-memory content; pass `fix: true` to either surface for safe rewrites and remaining-warning output.

---

## Team collaboration — important hazard

Plan files are git-tracked **source of truth**, but `linear_id:` is written back into each file by `plan apply`. If two teammates both run `plan apply` on the same plan directory **before the writeback commits land in git**, you get **duplicate issues in Linear** (each apply creates fresh ones with no shared identifier).

**Workflow for shared plans:**

1. One person ("first-applier") runs `lebop plan apply <dir>`.
2. **Immediately** commit the writeback (`git add <plan-dir>` → commit → push).
3. Everyone else pulls that commit **before** touching the plan.
4. From then on, `apply` / `diff` / `pull` by anyone on the team targets the same Linear entities.

If two people already applied in parallel: archive one issue set via `lebop archive <ids...> --yes`; clean duplicate projects with `lebop project soft-delete <project-id> --yes` when appropriate. Then rewrite the plan files to reference the keepers' `linear_id:` values.

---

## Configuration

`~/.lebop/config.yaml` is optional — `lebop` works with just auth. Config extends behavior per-repo:

```yaml
default_team: ENG                               # global fallback (single-workspace setups)

# Multi-workspace? Set per-workspace defaults instead — keyed by Linear
# workspace slug (the urlKey shown in `lebop auth list`):
workspace_team_defaults:
  acme: ENG
  acme-staging: STG

workspaces:
  acme:
    url_prefix: https://linear.app/acme         # needed by L004 (bracket issue refs)

repos:
  /Users/you/dev/billing-api:                   # absolute git-root path
    team: ENG                                   # team override for this repo
    conventions:
      bracket_issue_refs: true                  # L004 linter rule
    path_rewrites:                              # R001 linter rule
      - { from: "apps/api/", to: "services/billing/" }
    required_formats:                           # R002 linter rule — regex-based
      - { pattern: '\bpr-(\d+)\b', suggest: '[#$1]', message: "Use [#N] form" }
```

Team metadata is cached at `~/.lebop/cache/<workspace-slug>/<repo-hash>/_team/<TEAM>.yaml` with a 1h TTL; auto-refreshes on name-resolution misses (e.g., a project you just created).

---

## Agent integration

lebop ships **six isolated skills** (CLI medium × 3 roles + MCP medium × 3 roles) plus five **CLI slash commands**:

| Install name | Path | Role |
|---|---|---|
| `lebop-cli` | `agents/skills/cli/lebop/SKILL.md` | CLI monolith control plane |
| `lebop-cli-program` | `agents/skills/cli/lebop-program/SKILL.md` | CLI program compose / plan / updates |
| `lebop-cli-execution` | `agents/skills/cli/lebop-execution/SKILL.md` | CLI issue day-loop |
| `lebop-mcp` | `agents/skills/mcp/lebop/SKILL.md` | MCP monolith control plane |
| `lebop-mcp-program` | `agents/skills/mcp/lebop-program/SKILL.md` | MCP program compose (prefer full profile) |
| `lebop-mcp-execution` | `agents/skills/mcp/lebop-execution/SKILL.md` | MCP issue day-loop (core often enough) |
| slash commands | `agents/commands/lebop-*.md` | `/lebop-research`, `/lebop-pull`, `/lebop-push`, `/lebop-publish`, `/lebop-lint` |

Each skill is a **complete vertical** (no shared `references/`, no cross-skill links). CLI skills teach shell only; MCP skills teach tools only. Boundary: shell + `lebop` → CLI skills; MCP-only host → MCP skills. See [`agents/README.md`](agents/README.md).

The one-line release installer installs the `lebop` binary only. If you want the skills/command assets, install the one(s) you want in your agent of choice separately.

---

## MCP setup

`lebop mcp` runs over stdio and uses the same `~/.lebop/auth.json` as the CLI.
Use an absolute binary path if your MCP host does not inherit your shell PATH.
For project-scoped MCP configs, pin one Linear workspace with `LEBOP_WORKSPACE` (or auth default) so the agent always hits the intended org. Local cache/context already isolates by workspace slug; sibling clones are optional ops hygiene, not required for path correctness.

Claude Desktop style:

```json
{
  "mcpServers": {
    "lebop": {
      "command": "/Users/you/.local/bin/lebop",
      "args": ["mcp"],
      "env": {
        "LEBOP_WORKSPACE": "acme"
      }
    }
  }
}
```

Cursor project config (`.cursor/mcp.json`) uses the same command shape:

```json
{
  "mcpServers": {
    "lebop": {
      "command": "/Users/you/.local/bin/lebop",
      "args": ["mcp"]
    }
  }
}
```

---

## Install details (PATH)

`bun link` places the binary at `~/.bun/bin/lebop`, which is only on the PATH of interactive shells — **not** subprocesses spawned by agents like Claude Code. Two options:

**Option A — symlink into a universally-on-PATH directory (recommended):**
```sh
ln -sf "$HOME/.bun/bin/lebop" /opt/homebrew/bin/lebop   # macOS w/ Homebrew
# or on Linux:
# sudo ln -sf "$HOME/.bun/bin/lebop" /usr/local/bin/lebop
```

**Option B — shell-PATH only (interactive terminals only):**
```sh
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zprofile
# then restart your shell and any agent parent processes
```

Option A is required if you want agents started BEFORE you edited your shell config to find `lebop`.

---

## Why not just `@schpet/linear-cli` or Linear's MCP?

**Best for agents** lebop is built around the agent use cases (bulk markdown editing, declarative `plan apply`, renderer-aware lint, `updatedAt` stale-guarded push, MCP server). It deliberately skips interactive ergonomics that `@schpet/linear-cli` does extremely well — `issue start` (state + branch), `pr` (gh-cli wrapper), browser-open shortcuts, jj/git issue inference. "Linear is an extremely polished/performant sync engine with best in class UI for humans built on top of it. Therefore my entire company's context/work will be treated as a remote/durable file system exposed over linear's graphql api for my agents and exposed from a beautiful UI control plane for the humans." 

| | `@schpet/linear-cli` | Linear MCP server | `lebop` |
|---|---|---|---|
| Shape | Interactive CLI | Hosted MCP | Agentic CLI **and** MCP, bulk + declarative |
| Round-trip | Per-command | Per-tool-call | Pull-edit-push, plan-diff-pull |
| Mutation batching | Sequential | Sequential | One call per plan or one multi-alias push |
| Staleness guard | None | None | `updatedAt` check; `--force --yes` to bypass |
| Markdown lint | None | None | 8 rules (in-memory L001/L002/L003/L005/L006 + repo-scoped L004/R001/R002) |
| Declarative planning | Not a goal | Not exposed | Hero feature (project + issues) |
| GraphQL escape hatch | Yes | No | Yes (`raw`) |
| Local cache | No | No | Yes (`~/.lebop/cache/`) |
| `issue start` / branch / `pr` | Yes | No | **Deliberately skipped** — pair with `linear-cli` |

**For agent-driven work**, lebop replaces both `linear-cli` and the Linear MCP.

**Agent hazards (short):** Destructive and overwrite tools require `confirm: true` or CLI `--yes`. Cache `push`, plan apply, and publish refuse when remote is not fresh—refresh deliberately or use `--force --yes` only when you mean it (**force skips all freshness preflight**: stale + missing + invalid). Multi-workspace runs must select a workspace (`--workspace` / `LEBOP_WORKSPACE` / auth default) or state paths fail with `workspace_required`. Prefer first-class verbs; `raw` / `raw_graphql` mutations need their allow/confirm flags.

See [`docs/spec.md`](docs/spec.md) for the full motivation, design decisions, command reference, plan workflow, lint rule catalog, Linear API facts, discovered quirks, and release validation model.

---

## Documentation

- [`docs/spec.md`](docs/spec.md) — single source of truth: architecture, setup, full CLI reference, plan workflow, lint rules, Linear API facts, discovered quirks, and release validation.

## Development validation

```sh
bun run check
bun run typecheck
bun run test
```

Maintainer release validation from a source checkout:

```sh
bun scripts/live-surface-smoke.mjs
bun scripts/live-surface-smoke.mjs --validate-report docs/local/live-surface-report-<stamp>.json
```

`scripts/live-surface-smoke.mjs` is intentionally source-checkout-only. It
runs the full CLI + MCP live surface harness against the lebop-playground sandbox
workspace through the source wrapper. It uses `LEBOP_SANDBOX_TOKEN`, or the
existing `lebop-playground` auth token when that env var is absent, writes a JSON report
under ignored `docs/local/`, and best-effort archives/deletes resources it
creates.

For maintainer release validation, build the compiled binary first and set
`LEBOP_LIVE_BIN=/path/to/lebop` so the same harness tests the release artifact
instead of the source wrapper. Compiled-binary reports record mode, path,
version, SHA-256, byte size, platform, and architecture so the live proof can be
tied to the exact artifact being published.

`scripts/live-surface-smoke.mjs --validate-report` requires a completed report with no failed steps,
cleanup failures, CLI coverage misses, MCP coverage misses, or missing
semantic assertions for high-risk publish/context/write operations. **Gap allowlists**
(e.g. Option A agent-session view/get/fetch) document **temporary fixture constraints**
with an explicit **expiry date** — they are not product defects, but non-allowlisted
gaps remain release-blocking for a full-surface release report. A second harness,
`scripts/live-discovery-smoke.mjs`, covers discovery/feature paths; both harnesses honor
`LEBOP_LIVE_BIN` for compiled-binary provenance (same as the main surface smoke).
Release validation can also pin provenance with `LEBOP_LIVE_EXPECT_WORKSPACE`,
`LEBOP_LIVE_EXPECT_TEAM`, `LEBOP_LIVE_EXPECT_STAMP`,
`LEBOP_LIVE_EXPECT_BIN_MODE`, `LEBOP_LIVE_EXPECT_VERSION`, and
`LEBOP_LIVE_EXPECT_BIN_SHA256`.

---

## License

MIT — see [`LICENSE`](LICENSE). Contributions welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md).
