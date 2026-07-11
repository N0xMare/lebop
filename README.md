# lebop

[![ci](https://github.com/N0xMare/lebop/actions/workflows/ci.yml/badge.svg)](https://github.com/N0xMare/lebop/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/N0xMare/lebop?include_prereleases&sort=semver)](https://github.com/N0xMare/lebop/releases/latest)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-fbf0df)](https://bun.sh)

**Agentic Linear tool.** Gives agents and humans one CLI/MCP surface to explore, fetch, edit, review, and publish Linear work. It treats Linear issues as markdown files you can edit, diff, and apply the same way you already work with code. Ships as a CLI and an MCP server sharing one library core.

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

The installer drops a single self-contained binary (no Bun runtime needed) at `~/.local/bin/lebop` if writable, otherwise `/usr/local/bin/lebop` (sudo). Override with `LEBOP_INSTALL_DIR=...`. Pin a specific version with `LEBOP_VERSION=v0.0.4`.

**From source** (Bun required):

```sh
git clone https://github.com/N0xMare/lebop && cd lebop
bun install && bun link
mkdir -p "$HOME/.local/bin"
ln -sf "$HOME/.bun/bin/lebop" "$HOME/.local/bin/lebop"
# add ~/.local/bin to PATH if it isn't already (matches the binary installer)
```

Per-user config lives at `~/.lebop/config.yaml`; auth at `~/.lebop/auth.json` (mode 0600); local cache at `~/.lebop/cache/<repo-hash>/`; context dossiers and publish reviews live under `~/.lebop/context/` and `~/.lebop/publish-reviews/`. Commands that target user files, such as `plan apply`/`plan pull` writeback and explicit `--to` exports, write where you point them.
The local cache/context key is the repo path, so lebop assumes one Linear workspace per repo checkout. If the same codebase must be used with multiple Linear workspaces, use sibling clones instead of switching `--workspace` inside one checkout.

Full setup, config, and command reference: [`docs/spec.md`](docs/spec.md).

---

## Mental model: pick the right verb for what you want to do

Examples below use a fictional team key **`TEAM`** and issue IDs like **`TEAM-101`**. Replace with your Linear team prefix and real identifiers.

### Discover

```sh
lebop workspace explore / --json
lebop workspace explore /projects --query "Billing" --json
lebop workspace fetch /projects/<uuid> --depth full --json
lebop teams
lebop projects [--team KEY | --all-teams] [--state STATE] [--include-archived] [--limit N] [--cursor TOKEN] [--json]
lebop list --assignee me --state-type started
lebop list --project "Billing API v2" --label type:feature
```

For agents researching Linear work, `workspace explore` is the preferred ls-style discovery call and `workspace fetch` materializes a bounded local dossier for a project, issue, initiative, document, cycle, milestone, or agent session.
The MCP equivalents are `explore_linear_workspace` and `fetch_linear_workspace`; use the same two-step discovery-then-fetch flow when operating through MCP.
Bare issue identifiers like `TEAM-101` are accepted directly by both explore/fetch surfaces; qualified paths like `/issues/TEAM-101` also work.
Issue child paths such as `/issues/TEAM-101/documents` are fetchable when the question is about documents attached to a specific issue.
`--team` / MCP `team` narrows only project, issue, and cycle searches/listings. For initiatives, documents, milestones, and agent sessions, use `--kind`, concrete paths, child paths, smaller limits, or fetch controls instead.
`workspace explore` returns `next_cursor` for continuable project/initiative/issue listings, supported child listings, and search.
Collection/team explore paths are discovery-only (`fetchable: false`); concrete project, issue, initiative, document, cycle, milestone, and agent-session paths are fetchable. Non-cursor-backed capped listings return bounded metadata instead of implying completion.
`workspace explore --limit` is a page size; for search it applies per selected kind. `workspace fetch --limit` is not a global file budget: it applies per collection, per parent for nested issue fields, and per relation direction.
`workspace fetch` defaults to full depth; omitted `include` uses dossier defaults, while CLI `--include ""` or MCP `include: []` fetches only the root entity shell. For documents, explicit empty include omits content from markdown, summary, and manifest files. Truncated fetch manifests include `continuations` with exact follow-up explore/fetch calls.
Fetch narrowing controls are CLI `--include`, `--depth`, fetch `--limit`, and `--to`; MCP callers use `fetch_linear_workspace.include`, `depth`, `limit`, and `to`.
When Linear returns rate-limit headers, JSON/MCP workspace research results include optional `_meta.linear_api` telemetry with observed request/complexity budget, reset timing, and the number of API requests used by that tool call. Treat it as API-budget visibility, not as a pagination completeness signal.

### Read one issue

```sh
lebop show TEAM-101                 # print inline, no cache write — the right "just show me this"
lebop show TEAM-101 --json          # structured output for programmatic use
```

### Edit one field on one issue (fast, no cache round-trip)

```sh
lebop set state TEAM-101 "In Progress"
lebop set priority TEAM-101 urgent                 # name or 0..4
lebop set description TEAM-101 --description-file ./body.md
lebop set project TEAM-101 "Billing API v2"        # or null to detach
lebop set milestone TEAM-101 "Launch Milestone"    # or null to clear
lebop set cycle TEAM-101 "Cycle 12"                # or null to clear
lebop set labels TEAM-101 +urgent -area:backend    # delta syntax
lebop set assignee TEAM-101 @me
lebop set links TEAM-101 +blocks:TEAM-102 +related:TEAM-103   # 5 link kinds
lebop comment add TEAM-101 --body "LGTM"
```

Direct point edits write immediately and do not use the local cache `updatedAt`
snapshot. Use `pull` → edit → `push` or reviewed publish when staleness
protection matters.

### Edit a body with cache protection (multi-line description / project content)

```sh
lebop pull TEAM-101..TEAM-109                       # or space-separated list, or single id
# ... edit files under ~/.lebop/cache/<hash>/issues/TEAM-101/description.md ...
lebop status                                      # git-like: see what's modified
lebop push --dry-run                              # preview mutations
lebop push                                        # apply (updatedAt stale guard; --force --yes to bypass)
lebop publish review --cache TEAM-101 --json      # reviewed cache publish, returns review_id
lebop publish review --cache --all-modified --json # review every modified cache row
lebop publish apply <review-id> --json            # apply only reviewed cache state
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

### Plan a whole project declaratively (the hero workflow)

Author a **Linear project + its issues** as markdown on disk (not a Linear Initiative — those use `lebop initiative` / MCP initiative tools):

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
lebop publish review --plan plans/billing-api-v2 --json   # validate + lint + diff + dry-run; returns review_id
lebop publish apply  <review-id> --json                   # refuses if files changed; publishes + verifies
```

Re-apply is idempotent — unchanged files stay unchanged. Existing Linear updates require a fresh `_server.updated_at` snapshot written by `plan pull` or a previous successful apply; use `--force --yes` only after manually reviewing remote state. Parents get created before children (topological). Slug links auto-rewrite to `TEAM-###` once issues exist. Relations (`blocks` / `blocked_by` / `related` / `duplicates` / `duplicated_by`) honor Linear's single-record-per-pair semantics.

See [`docs/spec.md`](docs/spec.md#9-plan-workflow--declarative-authoring) for the full frontmatter schema, apply semantics, and edge cases.

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
lebop lint                                       # scans ~/.lebop/cache/<hash>/ by default
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

If two people already applied in parallel: archive one issue set via `lebop archive <ids...> --yes`; clean duplicate projects with `lebop project delete <project-id> --yes` when appropriate. Then rewrite the plan files to reference the keepers' `linear_id:` values.

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

Team metadata is cached at `~/.lebop/cache/<hash>/_team/<TEAM>.yaml` with a 1h TTL; auto-refreshes on name-resolution misses (e.g., a project you just created).

---

## Claude Code integration

lebop ships a user-level **skill** plus five **slash commands** that teach Claude Code agents when and how to use the tool:

| File | Role |
|---|---|
| `agents/skills/lebop/SKILL.md` | Invocation guide: verb-selection table, pull→edit→push loop, plan workflow, team-collaboration hazard, Linear quirks |
| `agents/commands/lebop-pull.md` | `/lebop-pull` slash command |
| `agents/commands/lebop-push.md` | `/lebop-push` slash command |
| `agents/commands/lebop-lint.md` | `/lebop-lint` slash command |
| `agents/commands/lebop-research.md` | `/lebop-research` slash command |
| `agents/commands/lebop-publish.md` | `/lebop-publish` slash command |

The content is platform-agnostic markdown — Claude Code uses the bundled
`./bin/install-claude` installer; other agents can be pointed at these
files however they expose skills/rules/prompts. See [`agents/README.md`](agents/README.md).

The one-line release installer installs the `lebop` binary only. To install
Claude Code skill/command assets, run the asset installer from a source or
package checkout that you keep on disk; it symlinks into `~/.claude` so
updates stay in sync with that checkout. Existing real skill directories or
same-named command files are moved to timestamped backups before symlinking.

```sh
./bin/install-claude
```

Restart Claude Code or open a new session to pick up the skill.

---

## MCP setup

`lebop mcp` runs over stdio and uses the same `~/.lebop/auth.json` as the CLI.
Use an absolute binary path if your MCP host does not inherit your shell PATH.
For project-scoped MCP configs, pin one Linear workspace per repo checkout; use sibling clones for multi-workspace work against the same codebase so local cache and context files stay separated.

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

**Best for agents, sufficient for humans.** lebop is built around the agent use case (bulk markdown editing, declarative `plan apply`, renderer-aware lint, `updatedAt` stale-guarded push, MCP server). It deliberately skips interactive ergonomics that `@schpet/linear-cli` does well — `issue start` (state + branch), `pr` (gh-cli wrapper), browser-open shortcuts, jj/git issue inference.

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

**For agent-driven work**, lebop replaces both `linear-cli` and the Linear MCP. **For solo human work**, pair lebop (bulk + plan + agent + stale guard) with `linear-cli` (interactive single-issue flows).

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
bun scripts/live-nox-surface-smoke.mjs
bun scripts/live-nox-surface-smoke.mjs --validate-report docs/local/live-nox-surface-report-<stamp>.json
```

`scripts/live-nox-surface-smoke.mjs` is intentionally source-checkout-only. It
runs the full CLI + MCP live surface harness against the NOX/Noxor sandbox
workspace through the source wrapper. It uses `LEBOP_NOXOR_TOKEN`, or the
existing `noxor` auth token when that env var is absent, writes a JSON report
under ignored `docs/local/`, and best-effort archives/deletes resources it
creates.

For maintainer release validation, build the compiled binary first and set
`LEBOP_LIVE_BIN=/path/to/lebop` so the same harness tests the release artifact
instead of the source wrapper. Compiled-binary reports record mode, path,
version, SHA-256, byte size, platform, and architecture so the live proof can be
tied to the exact artifact being published.

`scripts/live-nox-surface-smoke.mjs --validate-report` requires a completed report with no failed steps,
gaps, cleanup failures, CLI coverage misses, MCP coverage misses, or missing
semantic assertions for high-risk publish/context/write operations. Gap
allowlists only document temporary fixture constraints and expiry dates; any
gap is still release-blocking for a full-surface release report. Release
validation can also pin provenance with `LEBOP_LIVE_EXPECT_WORKSPACE`,
`LEBOP_LIVE_EXPECT_TEAM`, `LEBOP_LIVE_EXPECT_STAMP`,
`LEBOP_LIVE_EXPECT_BIN_MODE`, `LEBOP_LIVE_EXPECT_VERSION`, and
`LEBOP_LIVE_EXPECT_BIN_SHA256`.

---

## License

MIT — see [`LICENSE`](LICENSE). Contributions welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md).
