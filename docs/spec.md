# lebop — spec

The single source of truth for what lebop is, how it's designed, how to set it
up, and how to use it. If something here disagrees with the code, the code
wins — open a PR fixing this doc.

---

## 1. What lebop is

A TypeScript tool that gives coding agents (and humans) a complete, efficient,
correct interface to Linear. **Best for agents, sufficient for humans** — the
design is optimized for AI/automation workflows; humans get a competent CLI
but `@schpet/linear-cli` retains better interactive-only ergonomics
(branch-aware `issue start`, `pr` integration, browser-open shortcuts).

Two surfaces share a common lib core:

- **`lebop` CLI** — verbs for ad-hoc ops (`list`, `show`, `set`, `comment`,
  `new`, `archive`), bulk round-trip (`pull` → edit files → `push`),
  declarative authoring (`plan apply`), and a GraphQL escape hatch (`raw`).
- **`lebop mcp` server** — exposes the same surface as MCP tools so non-CLI
  agents (Cursor, Windsurf, hosted Claude, IDEs) get the same capabilities
  without shelling out. See §13.3.

One sentence: stateless tool over `@linear/sdk`, with markdown + YAML cache
under `~/.lebop/cache/<repo-hash>/` for the bulk loop and direct mutations for
single-shot ops. An `updatedAt` stale guard catches remote drift before guarded
writes; Linear does not expose a mutation-level `expectedUpdatedAt`, so this is
best-effort rather than atomic server-side CAS. The agent edits files (or calls
MCP tools); lebop owns the transport.

**Core assumption:** the calling agent has filesystem edit primitives
(`Read`/`Write`/`Edit`) **or** can issue MCP tool calls. The whole design
rests on materializing Linear state as files so agents use their existing
text-editing vocabulary instead of a Linear-specific tool surface; the MCP
server covers callers that can't round-trip through the filesystem.

---

## 2. Why this exists

Bulk Linear edits driven through `@schpet/linear-cli` or the official Linear
MCP server hit the same wall: every field becomes a separate API round-trip.

| Pain | Cost |
|---|---|
| No batch ops — N issue updates = N sequential CLI invocations | time + agent context |
| `linear project update` has no `--content-file`; requires raw GraphQL + `--variables-json` | friction |
| Raw Linear label updates require team labels + current issue labels + replacement `labelIds`; `labelIds` REPLACES | boilerplate hidden by CLI `set labels +/-` and MCP `update_issue labels_add/labels_remove` |
| Linear silently mutates markdown — table cells starting with `1.` get `\n\n` injected (ordered-list-marker quirk) | invisible until push → fetch → diff |
| No staleness protection — `issueUpdate` has no `expectedUpdatedAt` server-side precondition | silent clobber risk |
| `linear issue view` returns 3 KB of JSON for 300 bytes of description | context bloat |

Goal: collapse the agent workflow from "N round-trips per field" to "pull
once → edit files → push once," and provide first-class verbs for everything
the bulk loop doesn't cover (single-shot edits, comments, lifecycle ops,
declarative authoring).

---

## 3. Scope

### In scope (`0.0.4` shipped surface)

| Group | Commands |
|---|---|
| **Auth + workspace selection** | `auth login/logout/list/default/token/whoami/set-default-team`, root `--workspace` / `--team` |
| **Workspace research** | `workspace explore`, `workspace fetch` for projects, issues, initiatives, documents, cycles, milestones, agent sessions, and child collections |
| **Issue read/write** | `list`, `mine`, `show`, `new`, `set`, `bulk update`, `archive`, `unarchive`, `relation`, `link`, `attachment` |
| **Cache loop** | `pull`, `push`, `status`, `cache status/gc`, `diff`, `lint` |
| **Linear PM objects** | `project`, `projects`, `project-update`, `initiative`, `initiative-update`, `milestone`, `cycle`, `document`, `agent-session`, `label`, `team`, `teams`, `lookup` |
| **Declarative authoring** | `plan validate/apply/diff/pull/lint` plus reviewed `publish review/apply` |
| **Escape hatches + local utility** | `raw`, `schema`, `completions`, `mcp` |

Plus the runtime substrate:

- Native Linear PAK auth (`~/.lebop/auth.json`, mode 0600)
- Per-repo config at `~/.lebop/config.yaml`
- Local cache of issues / projects / comments / team metadata under
  `~/.lebop/cache/<repo-hash>/`
- `updatedAt` stale guard (refuse push on remote drift; `--force --yes` to bypass)
- Markdown linter with universal renderer rules + repo-scoped rules
- GraphQL escape hatch (`raw`)
- Agent skill + slash-command prompts (`agents/skills/lebop/`,
  `agents/commands/`) — platform-agnostic markdown; bundled installer
  for Claude Code, point any other agent at the files directly
- Cursor continuation on list/search surfaces that expose `--cursor` /
  `next_cursor`; bounded metadata on capped surfaces that do not yet expose a
  continuation token
- Structured error taxonomy (`LebopError` + 9 subtypes) — see §13.1

### Current release scope (see §13)

- **MCP server** (`lebop mcp`) wrapping the lib core
- **Bun-compiled standalone binaries** (single-file, no runtime install)
- **Workspace auth** (`auth list / default / token`, `--workspace` flag,
  mode-0600 auth JSON; no keyring command is shipped)
- **Linear CLI parity where useful** minus deliberately skipped
  interactive-only ergonomics — see §13.2 for shipped vs planned details
- **First-class Linear PM verbs**: initiatives + initiative-update,
  milestones, cycles (list/view), labels (list/create/delete),
  project-scoped documents (CRUD), agent-sessions (list/view), team members
  (list), team detail, team workflow states, project-update with `--health`
- **Issue link** (URL attach) and attachment lifecycle wrappers; file upload
  creation remains planned
- **Comment edit/delete** + replies
- **Rich issue filters** (`--search`, `--unassigned`, `--cycle`,
  `--milestone`, `--created-after`, `--include-archived`, `--all-teams`;
  `mine --all-states` for assigned work outside active states)
- **`lebop schema`** (offline GraphQL schema dump)
- **Shell completions** (bash/zsh/fish)

### Out of scope (deliberate)

- **Interactive-only ergonomics from linear-cli** — `issue start` (state
  change + branch creation), `pull-request` (gh-cli wrapper), `issue id` /
  `describe` / `commits` (jj/git inference), `-w/--web` / `-a/--app` open
  shortcuts. lebop is agent-first; pair with `@schpet/linear-cli` for
  these flows if you do solo human work.
- **Linear webhook subscriptions** — pull-on-demand model only
- **Multi-workspace content migration**
- **UI** — CLI + files + MCP only
- **Conflict merging after stale refusal** — abort and require explicit `pull --refresh --yes`
- **Comment edit on existing comment via cache** — comments are read-only
  in the cache; mutate via `comment update` direct command
- **Watch mode / autopush** — explicit action only
- **Cache-format schema migrations** — nuke cache and re-pull on format
  change

### Out of scope post-release (genuinely future, not pre-public)

- App-actor OAuth (`actor=app` audit-trail separation)
- MCP HTTP+SSE transport (stdio is the shipped shape)
- `lebop new --from <template>` template-driven scaffolding
- Sort control on `list`
- Default-template handling on `new`
- `team create / delete / autolinks` (rare UI-managed ops; use raw GraphQL only when explicitly requested)
- Issue delete (`archive` is the supported path; destructive ops via `raw`)

---

## 4. Setup

### 4.1 Prerequisites

| Install path | Bun required? | Scope |
|---|---:|---|
| GitHub Releases binary installer | No | Normal CLI/MCP use |
| Source checkout, local development, tests, release builds | Yes, Bun 1.3.13+ | `bun install`, `bun link`, tests, compiled binaries |

All install paths need a **Linear personal API key** (Linear → Settings → API
→ Personal API keys → Create key).

### 4.2 Install

Recommended binary install:

```sh
curl -fsSL https://raw.githubusercontent.com/N0xMare/lebop/main/scripts/install.sh | bash
```

The installer downloads the matching GitHub Releases binary for macOS/Linux
x64/arm64, verifies it against `SHA256SUMS`, and writes it to
`~/.local/bin/lebop` or `/usr/local/bin/lebop`. Pin a release with
`LEBOP_VERSION=v0.0.4`.

From source (Bun required):

```sh
git clone <repo-url>
cd lebop
bun install
bun link
```

`bun link` places the binary at `~/.bun/bin/lebop`. **Important:**
`~/.bun/bin` is only on the PATH of interactive shells — *not* subprocesses
spawned by agents like Claude Code. Symlink it into a universally-on-PATH
directory:

```sh
# macOS (Homebrew)
ln -sf "$HOME/.bun/bin/lebop" /opt/homebrew/bin/lebop

# Linux
sudo ln -sf "$HOME/.bun/bin/lebop" /usr/local/bin/lebop
```

Verify:

```sh
lebop --version       # 0.0.4
which lebop           # /opt/homebrew/bin/lebop (or /usr/local/bin/lebop)
```

### 4.3 Authenticate

```sh
lebop auth login
```

Prompts for your PAK (hidden input). Validates by fetching `viewer +
organization`; rejects on auth failure. The organization's `urlKey` is
used as the **workspace slug** — the canonical identifier for selecting
which set of credentials to use later.

Alternatives:

```sh
lebop auth login --token-file path/to/token
lebop auth login --from-schpet            # import from @schpet/linear-cli
lebop auth login --token "lin_api_..."    # avoid when possible; shell history can leak it
```

Stored at `~/.lebop/auth.json` (mode 0600, dir 0700). The file supports
multiple workspaces; running `auth login` again with a token for a
different organization adds it as another entry.

```sh
lebop auth list                    # list configured workspaces (default marked *)
lebop auth list --json             # structured records
lebop auth default                 # print current default slug
lebop auth default <slug>          # set the default workspace
lebop auth token [<slug>]          # print masked token preview
lebop auth token [<slug>] --unsafe # print full token for piping to curl
lebop auth whoami [<slug>]         # show cached viewer for a workspace
lebop auth whoami [<slug>] --refresh   # re-validate against Linear
lebop auth logout [<slug>]         # remove one workspace; if only one is configured, removes the file
```

**Workspace selection** for any command:

1. `--workspace <slug>` flag (top-level, applies to all subcommands)
2. `LEBOP_WORKSPACE` env var
3. The auth file's `default`
4. The single configured workspace if there's exactly one

If none match (multiple workspaces, no default, no flag/env), lebop
errors with the available slugs.

On 401 from any command, lebop emits a clean message pointing back at
`lebop auth login` — no silent reauth.

### 4.4 Configure (optional)

`~/.lebop/config.yaml` is optional — lebop works with just auth. Configure
it when you want a default team, per-repo overrides, or repo-scoped lint
rules:

```yaml
default_team: ENG                               # global fallback (single-workspace setups)

# Time-to-live for the on-disk team-metadata cache (states/labels/members/projects).
# Default 3600s (1h). Lower it when your workspace's labels/states change often,
# raise it to cut API traffic on stable workspaces.
team_metadata_ttl_seconds: 3600

# Multi-workspace? Set per-workspace team defaults keyed by Linear
# workspace slug (the urlKey — what appears after `linear.app/` and in
# `lebop auth list`). Avoids `default_team` leaking across workspaces.
workspace_team_defaults:
  acme: ENG
  acme-staging: STG

workspaces:
  acme:
    url_prefix: https://linear.app/acme                 # required by L004

repos:
  /Users/you/dev/billing-api:                   # absolute git-root path
    team: ENG                                   # team override for this repo
    conventions:
      bracket_issue_refs: true                  # L004 linter rule
    path_rewrites:                              # R001 linter rule
      - { from: "apps/api/", to: "services/billing/" }
    required_formats:                           # R002 linter rule (regex)
      - { pattern: '\bpr-(\d+)\b', suggest: '[#$1]', message: "Use [#N] form" }
```

Team resolution precedence (first match wins):
1. `--team KEY` flag on the command
2. Per-repo `team` (matched on absolute git-root path)
3. `workspace_team_defaults[<active-workspace-slug>]` — active workspace
   resolved from `LEBOP_WORKSPACE` env (set by `--workspace <slug>`) or
   the auth file's stored default
4. `default_team` (legacy / single-workspace fallback)

When cwd isn't in a git repo, the cache is keyed by `_global` and the
above team resolution still applies.

**Tuning via environment variables:**

| Env var | Default | Effect |
|---|---|---|
| `LEBOP_MAX_ITEMS` | `10000` | Hard cap on items any paginated list operation will return. lebop emits a one-shot stderr warning when a walk crosses 50% of the cap, and throws `ValidationError` (`code: validation_error`) if the cap is hit while the server still reports more pages. Set higher (`LEBOP_MAX_ITEMS=50000`) for genuinely large workspaces, or lower for tight CI envs. |
| `LEBOP_HOME` | `~/.lebop` | Root for auth, config, cache, context dossiers, and publish review records. Useful for test isolation. |
| `LEBOP_WORKSPACE` | unset | Active Linear workspace slug; set by `--workspace <slug>`. |
| `LEBOP_TEAM` | unset | Active team key; set by `--team KEY` or as an explicit override. |

### 4.5 Agent integration (optional)

lebop ships agent-facing assets as **plain markdown** under `agents/`:

```
agents/
├── README.md                     # how to wire any agent to lebop
├── skills/lebop/SKILL.md         # main "how an agent uses lebop" guide
└── commands/                     # individual slash-command prompts
    ├── lebop-research.md
    ├── lebop-pull.md
    ├── lebop-push.md
    ├── lebop-publish.md
    └── lebop-lint.md
```

The frontmatter on `SKILL.md` is Claude Code-compatible; the body is
portable across platforms.

**Claude Code** — bundled asset installer:

```sh
./bin/install-claude
```

Run this from a source or package checkout that will remain on disk. It
symlinks the whole `agents/skills/lebop/` directory →
`~/.claude/skills/lebop/` and each `agents/commands/*.md` file →
`~/.claude/commands/`. Re-run anytime —
symlinks stay in sync with `git pull`. Existing real skill directories or
same-named command files are moved to timestamped backups before symlinking.
Restart Claude Code to pick up the skill.

The one-line release installer installs only the standalone `lebop` binary.
CLI and MCP work without these markdown assets; install the assets separately
when you want Claude Code skill/slash-command guidance.

**Other agents** — point your platform's skill/rule/prompt loader at the
files in `agents/` directly. The content is the same.

---

## 5. Architecture

### 5.1 Shape

```
lebop/                                # this repo
├── bin/
│   ├── lebop                         # CLI entry: #!/usr/bin/env bun → src/cli.ts
│   └── install-claude                # symlink installer for Claude Code (agents/skills + commands)
├── src/
│   ├── cli.ts                        # commander dispatcher; registers thin command modules
│   ├── commands/                     # thin shells: argv → surface/lib → format
│   ├── surface/                      # authority: SURFACE_OPERATIONS + domain contracts
│   │   ├── contracts.ts              # op metadata, exceptions, live/confirm fields
│   │   ├── deriveToolSurfaceManifest.ts  # L2: CLI/MCP/live inventories from ops
│   │   └── <domain>.ts               # per-domain ops (issues, projects, …)
│   ├── mcp/
│   │   ├── server.ts                 # stdio MCP boot: create server, register tools
│   │   └── tools/                    # thin MCP tool modules over surface/lib
│   └── lib/                          # domain core: Linear behavior + local state
│       ├── auth/config/requestContext # credentials, defaults, per-call workspace/team scope
│       ├── sdk/retry/paginate/raw     # Linear SDK access, retry, GraphQL pagination/escape hatch
│       ├── issues/projects/etc.       # entity CRUD/list helpers for Linear concepts
│       ├── resolve/lookups            # name/key/UUID resolution and team metadata
│       ├── cache/pull/push/diff       # local cache, updatedAt snapshots, mutations, status
│       ├── workspaceExplore/workspaceFetch # ls-style discovery and local context dossiers
│       ├── workspaceContextWriter     # safe local context materialization
│       ├── planParse/Validate/Apply   # declarative plan parsing, linting, realization, sync
│       ├── linearPublish/publishStore # review/apply publish workflow records
│       ├── lint/quirks                # Linear markdown renderer rules
│       ├── toolSurfaceManifest        # thin re-export of derived L2 inventories
│       └── toolBehaviorContracts      # payload/behavior contracts used by tests + live harness
├── tests/                            # vitest unit/integration tests plus harness contract tests
├── scripts/                          # installer, package checks, live Noxor full-surface harness
├── .github/workflows/                # CI, canary, release gates
├── agents/                           # platform-agnostic agent integrations
│   ├── README.md
│   ├── skills/lebop/SKILL.md
│   └── commands/lebop-{research,pull,push,publish,lint}.md
└── docs/
    ├── spec.md                       # this file (single source of truth)
    └── examples/getting-started/     # generic example plan

~/.lebop/                             # runtime state — never touched by git
├── auth.json                         # PAK + viewer cache (0600)
├── config.yaml                       # optional user config
├── cache/<repo-hash>/
│   ├── issues/<IDENTIFIER>/
│   │   ├── description.md            # user-editable
│   │   ├── metadata.yaml             # user-editable + _server: snapshot
│   │   └── comments/<comment-uuid>.md  # read-only; refreshed on pull
│   ├── projects/<project-uuid>/
│   │   ├── content.md
│   │   └── metadata.yaml
│   └── _team/<TEAM-KEY>.yaml         # team metadata (1h TTL)
├── context/<repo-hash>/              # workspace fetch dossiers (research exports)
└── publish-reviews/<review-id>.json  # reviewed publish records
```

`<repo-hash>` = `sha256(absolute-git-root-path).slice(0, 12)`. Deterministic,
short, keeps multi-repo caches separated. Fallback `_global` when cwd isn't
in a git repo.

**Principle:** default lebop auth/cache/context/publish-review state lives
under `~/.lebop/`. Commands that target user files, such as `plan
apply`/`plan pull` writeback and explicit `--to` exports, write where the
caller points them.

### 5.2 Authority model (lib, surface, thin adapters)

lebop has one durable Linear/domain core and two thin agent-facing adapters:

| Layer | Role |
|---|---|
| **`lib/`** | Domain authority — SDK calls, cache, plan/publish, resolve, lint, retries. Shared by CLI and MCP. No transport I/O. |
| **`surface/`** | Contract authority — `SURFACE_OPERATIONS` declares each dual/exception op (CLI command, MCP tool, safety, live steps/semantics, notes). |
| **`commands/` + `mcp/tools/`** | Thin adapters — parse argv / MCP args, call surface/lib, format human/JSON or MCP envelopes. |
| **`mcp/server.ts`** | Boot-only — create the stdio server and register tools from modular `mcp/tools/*`. |
| **L2 inventory** | Derived — `deriveToolSurfaceManifest` builds CLI/MCP/live manifests from `SURFACE_OPERATIONS`. `lib/toolSurfaceManifest.ts` re-exports those derived inventories (no second handwritten tool/command list). |

Wrapper-specific code belongs to argument normalization, transport formatting,
error envelopes, and request-local workspace/team scope. Durable Linear
behavior belongs in `lib/` and is covered by shared contracts/tests. Adding a
dual-surface op means registering it on `SURFACE_OPERATIONS` and wiring thin
adapters — not editing a separate parity inventory.

### 5.3 Atomicity

All cache writes go via temp-file + `rename`. No partial writes are visible
to a concurrent reader. See `lib/cache.ts`.

---

## 6. The pull → edit → push loop

The hero workflow for bulk and multi-line edits.

```sh
# 1. Pull entities into the cache
lebop pull TEAM-101..TEAM-109            # range
lebop pull TEAM-101 TEAM-102 TEAM-103    # list
lebop pull --project "Billing API v2"    # whole project + its issues
lebop pull TEAM-101 --to ./scratch       # export mode (no cache write)

# 2. Edit the markdown + YAML files in-place
$EDITOR ~/.lebop/cache/<hash>/issues/TEAM-101/description.md
$EDITOR ~/.lebop/cache/<hash>/issues/TEAM-101/metadata.yaml

# 3. Inspect what changed (git-like)
lebop status

# 4. (Optional) Lint before push
lebop lint              # walks the cache; warns by default
lebop lint --fix        # apply safe rewrites
lebop lint --strict     # exit non-zero on any warning

# 5. Preview the mutations
lebop push --dry-run

# 6. Push
lebop push              # guarded by updatedAt stale checks
lebop push --force --yes  # skip stale guard (after manual reconciliation)
lebop push --strict     # block on lint warnings
```

### 6.1 `pull` — fetch entities into the cache

```
lebop pull [IDS...] [--team KEY] [--project NAME] [--project-id UUID]
                    [--refresh] [--yes|--confirm] [--no-comments] [--to <dir>] [--json]
```

By default writes `description.md` + `metadata.yaml` atomically per entity.
Comments are bundled into `issues/<ID>/comments/<comment-uuid>.md` as
read-only files with YAML frontmatter, because agents routinely need thread
context.

- Refuses overwriting locally-modified entries unless `--refresh --yes` (or
  `--refresh --confirm`)
- `--refresh` requires `--yes` or `--confirm` because it can overwrite
  local cached edits.
- `--to <dir>` switches to **export mode**: writes to `<dir>/<id>/` instead
  of the cache, skipping the unpushed-edits guard. `status` and `push` only
  see the canonical cache; `--to` files are leaf copies for "drop issue
  context next to code." A warning is printed to make this clear.
- Per-entity GraphQL errors are tolerated — successful entities still land.

### 6.2 `workspace` — explore/fetch Linear context

```
lebop workspace explore [path] [--query TEXT] [--team KEY]
                         [--kind project|issue|initiative|document|cycle|milestone|agent-session]
                         [--include-archived] [--limit N]
                         [--cursor TOKEN] [--json]

lebop workspace fetch <target> [--include ITEMS] [--depth shallow|full]
                       [--limit N] [--cursor TOKEN] [--to DIR] [--json]
```

`workspace explore` is an ls-style discovery layer over Linear concepts.
It returns concise records with stable paths such as `/projects/<id>`,
`/issues/TEAM-123`, and `/initiatives/<id>`, plus `next_paths` for
follow-up exploration. When `--query` is provided, it searches projects,
issues, initiatives, documents, cycles, milestones, and agent sessions from
one call for agent disambiguation. `--kind` can narrow that search and
accepts singular/plural aliases for `project`, `issue`, `initiative`,
`document`, `cycle`, `milestone`, and `agent-session`; `agent_session` and
`agent_sessions` are accepted underscore aliases.
Explore collection/team paths are discovery-only and are marked
`fetchable: false`; concrete project, issue, initiative, document, cycle,
milestone, and agent-session records are fetchable. Non-cursor-backed capped collections
return conservative `page.bounded` metadata with `continuation:
"not_available"` instead of reporting completion.
The MCP equivalent is `explore_linear_workspace` with the same discovery
contract through JSON-RPC. Use one of these surfaces as the first call when
an agent needs to understand what Linear context exists.
`--team` / MCP `team` narrows only project, issue, and cycle
searches/listings. It is not a generic workspace narrowing control for
initiatives, documents, milestones, or agent sessions; use `--kind`,
concrete paths, child paths, smaller limits, or fetch controls for those.
`--limit` is the normal page size for listings. For search, it applies per
selected kind, so the total returned item count can exceed `--limit`.

`workspace fetch` materializes a bounded project, issue, initiative,
document, cycle, milestone, agent-session, or supported child-collection
dossier into local files. Omitted `--include` uses the default dossier shape;
CLI `--include ""` or MCP `include: []` means no optional child collections.
Omitted `--depth` defaults to `full` on both CLI and MCP. The command response stays small: root path,
manifest path, counts, omitted/truncated metadata, continuations, and
recommended files to read first. Context dossiers live under
`~/.lebop/context/<repo-hash>/`
unless `--to` is provided. They are research exports, not editable cache
rows, so `status`/`push` still operate only on `~/.lebop/cache`.
`--limit` is not a global dossier budget: it applies per collection, per
parent for nested issue fields, and per direction for relations.
Use `--cursor` only with a continuation token returned by a prior
`workspace fetch` / `fetch_linear_workspace` response; continuations preserve
the target-specific include projection.
The MCP equivalent is `fetch_linear_workspace`; it writes the same style of
local dossier and returns the same compact manifest shape for agents that
cannot or should not shell out to the CLI. Its narrowing fields are
`include`, `depth`, `limit`, and `to`, matching CLI `--include`, `--depth`,
fetch `--limit`, and `--to`.
Document fetches include content by default; explicit empty include writes
only the document shell and omits content from markdown, summary, and
manifest files.

When Linear includes rate-limit headers, `workspace explore`,
`workspace fetch`, `explore_linear_workspace`, and `fetch_linear_workspace`
attach optional envelope sidecar metadata at `_meta.linear_api`. This is
transport/API-budget visibility, not part of the semantic workspace result
or fetch manifest. It includes observed request count for the tool call and
the latest Linear request, endpoint, and complexity budget headers when
available. Agents should narrow with `--kind`, smaller explore/fetch
`--limit`, fetch `include`/`depth`, child paths, or concrete targets when
remaining request or complexity budget is low; use `--team` / MCP `team`
only for project, issue, or cycle discovery.

Allowed `workspace fetch --include` / `fetch_linear_workspace.include`
vocabulary is dossier-kind specific. CLI accepts comma-separated values or
`--include ""` for an explicit empty include; MCP accepts an array, with
`include: []` as the explicit empty include. Hyphenated aliases normalize to
underscores.

| Dossier kind | Allowed includes |
|---|---|
| `project` | `issues`, `issue_details`, `comments`, `relations`, `attachments`, `agent_sessions`, `issue_documents`, `issue_document_details`, `documents`, `document_details`, `updates`, `milestones` |
| `issue` | `comments`, `relations`, `attachments`, `agent_sessions`, `documents`, `document_details` |
| `initiative` | `projects`, `project_issues`, `issue_details`, `comments`, `relations`, `attachments`, `agent_sessions`, `issue_documents`, `issue_document_details`, `project_documents`, `project_document_details`, `updates`, `project_updates`, `project_milestones` |
| `document` | `content` |
| `cycle` / `milestone` | `issues`, `issue_details`, `comments`, `relations`, `attachments`, `agent_sessions`, `issue_documents`, `issue_document_details` |
| `agent-session` | no optional includes |

### 6.3 `publish` — review/apply/verify plan or cache content

```
lebop publish review --plan <dir> [--team KEY] [--strict] [--json]
lebop publish review --cache [IDS...] [--project-id UUID...] [--all-modified] [--team KEY] [--strict] [--json]
lebop publish apply <review-id> [--no-verify] [--json]
```

`publish review` is the task-shaped write preview for agent-authored plan
directories. It validates, lints, diffs, dry-runs the plan apply, then
stores a local review record under `~/.lebop/publish-reviews/`. The
result includes a `review_id`, readiness summary, blockers, validation
errors/warnings, lint warnings, drift, and the next publish call.

With `--cache`, `publish review` reviews modified editable cache rows
instead of a plan directory. It supports issue identifiers and
`--project-id` selectors, plus `--all-modified` when the intended target is
every modified cache row. The review hashes the selected cache files, lints
changed issue descriptions/project content, captures remote `updatedAt`
snapshots, and dry-runs the shared cache push engine.

`publish apply <review-id>` publishes only the reviewed content. Before
mutating Linear it recomputes the reviewed plan/cache hash and refuses if
local files changed after review. It also refuses when Linear changed since
the review snapshot. By default it verifies the result and returns
`status: "verified"` only when the remote/cache state matches the reviewed
intent. `--no-verify` is accepted only by `publish apply`; do not pass it to
`publish review`. With `--no-verify`, apply skips the post-publish verification step
and returns `status: "published_unverified"` on successful unverified
publish.

### 6.4 `push` — diff cache vs remote, mutate

```
lebop push [IDS...] [--team KEY] [--dry-run] [--force] [--yes|--confirm] [--strict]
                  [--project-id UUID ...] [--json]
```

Per-entity flow:

1. Read local files.
2. Fetch current remote `updatedAt` (batched query across all entities being
   pushed).
3. **Stale guard:** if remote `updatedAt` differs from local
   `_server.updated_at`, abort this entity and report conflict. For an issue
   cache row, suggest
   `lebop pull TEAM-123 --refresh --yes`; for a project cache row, suggest
   `lebop pull --project-id <uuid> --refresh --yes`, after confirming local
   cache overwrite. Real mutations re-read `updatedAt` immediately before the
   write to shrink the race window. Because Linear exposes no mutation-level
   `expectedUpdatedAt`, this remains a best-effort stale guard, not atomic
   server-side CAS. `--force --yes` skips the guard.
4. Compute field-level diff. Resolve names → UUIDs via cached team metadata.
5. Emit `issueUpdate` / `projectUpdate` with **only changed fields**.
6. Refresh local `_server.*` from the mutation response (Linear normalizes
   markdown server-side; we write the normalized form back so the cache
   stays clean immediately — no hash drift).

Bare `lebop push` pushes everything in the current repo's cache; passing IDs
narrows the set. Field-level diff is load-bearing — don't clobber fields the
agent didn't touch.

### 6.5 `status` — git-like diff against `_server`

```
On team: ENG  (repo: /Users/you/dev/billing-api)

Modified locally (4):
  TEAM-101  description, labels
  TEAM-102  description
  TEAM-108  description
  project/<uuid>  content

Clean (5):
  TEAM-103 TEAM-104 TEAM-105 TEAM-106 TEAM-107
```

Computes local-vs-`_server` diffs and, unless `--no-remote` is passed,
checks remote `updatedAt` so clean cached rows can surface as
`stale (remote newer)` before push.

### 6.6 `diff <ID>` — unified diff vs live remote

Fetches fresh remote, renders a markdown-aware unified diff for one entity.
Exits 1 on drift (script-friendly "is dirty?" signal). `--json` emits the
structured patch.

### 6.7 `show <ID>` — read inline, no cache write

The right verb for "what is this issue about?" — `pull` is overkill when
you're not going to edit. Default output is a compact header + title + tags
+ description + comments. `--no-comments` for description-only;  `--json`
for `{ schema_version, metadata, description, comments }`.

---

## 7. File formats

### 7.1 `cache/<repo-hash>/issues/<ID>/description.md`

Pure markdown. The only field that round-trips between agent and Linear in
this file. Nothing else.

### 7.2 `cache/<repo-hash>/issues/<ID>/metadata.yaml`

```yaml
identifier: TEAM-123
title: "example issue title"
state: Todo                 # by name → resolved to stateId on push
priority: 1                 # 0 none | 1 urgent | 2 high | 3 normal | 4 low
estimate: 3                 # numeric points; `null` clears
labels:                     # by name → resolved to labelIds on push
  - area:backend
  - type:refactor
assignee: null              # or email / name / @me
project: Billing API v2     # by name, for readability
parent: TEAM-100            # bare TEAM-NN identifier; `null` clears
# ---- server-owned; do not edit ----
_server:
  id: <uuid>
  identifier: TEAM-123
  url: https://linear.app/<workspace-slug>/issue/TEAM-123/...
  state_id: <uuid>
  state_name: Todo
  state_type: unstarted
  priority: 1
  estimate: 3
  label_ids: [{ id: <uuid>, name: area:backend }, ...]
  assignee_id: null
  assignee_name: null
  assignee_email: null
  title: "example issue title"
  description_hash: <sha256>
  project_id: <uuid>
  project_name: Billing API v2
  parent_id: <uuid>
  parent_identifier: TEAM-100
  updated_at: "2026-01-01T00:00:00Z"   # used for the stale guard
```

On push, everything under `_server:` is ignored except `updated_at` (the
staleness check input). Editable top-level fields — including `estimate`
and `parent` — round-trip cleanly: edit in-place, run `lebop status` to see
the diff, `lebop push` to apply.

### 7.3 `cache/<repo-hash>/projects/<uuid>/content.md`

Project long-form body.

### 7.4 `cache/<repo-hash>/projects/<uuid>/metadata.yaml`

```yaml
name: Billing API v2
description: "short project tagline (≤255 chars)"
icon: Rocket
start_date: 2026-06-01     # YYYY-MM-DD; `null` clears
target_date: 2026-06-30    # YYYY-MM-DD; `null` clears
state: started
_server:
  id: <uuid>
  url: https://linear.app/<workspace-slug>/project/...
  state: started
  name: Billing API v2
  description: "short project tagline (≤255 chars)"
  icon: Rocket
  start_date: 2026-06-01
  target_date: 2026-06-30
  content_hash: <sha256>
  updated_at: "2026-01-01T00:00:00Z"
```

On push, editable top-level project fields round-trip for `name`,
`description`, `icon`, `state`, `start_date`, `target_date`, and
`content.md`. Use `null` for `start_date` or `target_date` to clear the date in
Linear. Everything under `_server:` is snapshot data; do not edit it.

### 7.5 Cache hashing + GC

The per-repo cache lives at `~/.lebop/cache/<repo-hash>/`, where
`<repo-hash>` is the first 12 chars of `sha256(absolute-git-root-path)` —
deterministic, short, keeps multi-repo caches separated. When cwd isn't
inside a git repo, lebop falls back to the literal hash `_global`.
Implementation: `repoHashForPath` / `detectCwdRepoHash` in `lib/cache.ts`.

Over time the cache accumulates hashes for repos the user no longer
touches. `lebop cache gc` (and the matching `cache_gc` MCP tool) reports
or removes stale per-repo subdirs. Defaults are conservative — dry-run
on, current-repo preserved, age threshold 30 days, total-size cap 500 MB.
See §8.29 for the full surface. The GC reads + writes only the
`<repo-hash>/` subdirs; `auth.json`, `config.yaml`, and team caches are
never touched.

**Constraint: one Linear workspace per repo dir.** The cache key is
`sha256(repo-root-path)`, **not** `sha256(repo-root-path, workspace-slug)`.
If you run lebop against two different Linear workspaces from the same
repo dir, their entities share one `<repo-hash>/` subtree and
`lebop status` will surface both sets together. The supported usage is:
one workspace per repo. If you need multi-workspace use against one
codebase, work from sibling clones (`~/code/proj-foo/`,
`~/code/proj-bar/`) — they hash to different `<repo-hash>` values and
their caches stay separated. Workspace-keyed cache layout and a migration
path can be revisited if the one-workspace-per-repo assumption changes.

---

## 8. CLI command reference

Remote commands that operate inside a team usually accept `--team <KEY>`
(default from config); workspace-wide commands, auth/local utilities, and
explicit all-team modes do not. Commands intended for agent composition usually
accept `--json` with a stable schema (`{ "schema_version": 1, ... }`). Treat
the signatures below as authoritative for exact `--team` / `--json` support.

### 8.1 `auth`

```
lebop auth login [--token TOKEN | --token-file FILE | --from-schpet]
lebop auth logout [<slug>]
lebop auth list [--json]
lebop auth default [<slug>]
lebop auth token [<slug>] [--unsafe]
lebop auth whoami [<slug>] [--refresh] [--json]
lebop auth set-default-team <workspace> <team> [--json]
```

See §4.3 for selection rules and the multi-workspace data model.

`auth token` prints a masked preview by default. Pass `--unsafe` only when
you intentionally need the full secret, for example when piping directly to
another process.

### 8.2 `list` — issue search

```
lebop list [--team KEY | --all-teams]
           [--project NAME | --project-id UUID]
           [--state NAME] [--state-type triage|backlog|unstarted|started|completed|canceled]
           [--assignee me|EMAIL|NAME|*] [--unassigned]
           [--label NAME ...] [--priority 0..4]
           [--cycle NAME-OR-ID] [--milestone NAME-OR-ID]
           [--updated-since 7d|24h|ISO] [--created-after 7d|24h|ISO]
           [--search TEXT]
           [--include-archived]
           [--limit N | --limit 0] [--cursor TOKEN] [--json]
```

Default output: one line per issue, `IDENT  [STATE]  TITLE  (assignee)`.
Default limit 50; `--limit 0` means "no user-specified cap" (the
paginator's safety cap of 10k still applies).
When output is truncated, JSON includes `next_cursor`; pass it back with the
same filters to continue.

`--search` runs full-text against `searchableContent` (title + body).
`--unassigned` and `--assignee` are mutually exclusive. `--all-teams`
drops the team filter for workspace-wide queries in the selected workspace.

### 8.3 `mine` — your assigned work

```
lebop mine [--team KEY | --all-teams]
           [--all-states] [--include-archived]
           [--state-type TYPE] [--label NAME ...] [--priority 0..4]
           [--cycle NAME-OR-ID] [--milestone NAME-OR-ID]
           [--limit N] [--cursor TOKEN] [--json]
```

Shorthand for `list --assignee me` with a default state filter (active
states only — anything that isn't `completed` or `canceled`). Pass
`--all-states` to include those, or `--state-type` to narrow further.
When output is truncated, JSON includes `next_cursor`; pass it back with the
same filters to continue.

### 8.4 `projects` / `teams` — discovery

```
lebop projects [--team KEY | --all-teams] [--state STATE] [--include-archived] [--limit N] [--cursor TOKEN] [--json]
lebop teams [--json]
```

Useful for seeding `config.yaml` and discovering the right team key.

### 8.5 `show <ID>` — read inline

See §6.7.

### 8.6 `pull / push / status / diff / lint`

See §6.

### 8.7 `comment` — full CRUD

```
lebop comment add <ID> [--body TEXT | --body-file FILE | --stdin]
                       [--parent COMMENT-UUID]      # reply (threads)
                       [--json]
lebop comment list <ID> [--json]
lebop comment update <COMMENT-UUID> [--body TEXT | --body-file FILE | --stdin] [--json]
lebop comment delete <COMMENT-UUID> [--yes] [--json]
```

Direct mutations on comments; no cache round-trip. `add` is the new
canonical form for what was previously `lebop comment <id>` — the bare
form is gone, prefix with `add`. `list` is paginated and chronological;
`update`/`delete` take the comment's UUID (visible in `list` output).

### 8.8 `project` — manage Linear projects (CRUD)

```
lebop project list [--team KEY | --all-teams] [--state NAME] [--include-archived] [--limit N] [--cursor TOKEN] [--json]
lebop project view <id> [--json]
lebop project create <name> [--team KEY] [--team-key KEY ...] [--team-id UUID ...] [--description] [--content] [--icon NAME] [--state] [--start-date] [--target-date] [--json]
lebop project update <id> [--name] [--description] [--content] [--icon NAME|null] [--state] [--start-date ISO|null] [--target-date ISO|null] [--json]
lebop project delete <id> [--yes] [--json]
```

Full project CRUD. `project create` accepts a single `--team KEY`,
repeatable `--team-key KEY`, repeatable `--team-id UUID`, or the configured
default team when no selector is supplied. Multiple selectors create a
multi-team Linear project. `--icon` takes Linear's internal icon name such as
`BarChart`, `Rocket`, or `Target`; emoji are rejected because Linear stores
icon names, not Unicode emoji. `update --icon null` clears the icon.
`update --start-date null` clears the date. `view` shows description +
content + lead + teams + icon + dates.
The legacy `lebop projects` (plural, list-only) is kept as an alias for
`lebop project list`, including `--all-teams`, `--state`,
`--include-archived`, `--limit`, `--cursor`, and the structured JSON
envelope.

### 8.9 `project-update` — project status updates with health

```
lebop project-update create <project> [--body | --body-file | --stdin] [--health onTrack|atRisk|offTrack] [--json]
lebop project-update list <project> [--json]
```

`<project>` accepts a name or UUID. `--health` is the standard Linear
status flag (mirrors linear-cli).

### 8.10 `initiative` — org-level planning units (CRUD)

```
lebop initiative list [--status NAME] [--owner-id UUID] [--include-archived] [--limit N] [--json]
lebop initiative view <id-or-name> [--json]
lebop initiative create <name> [--description] [--status] [--owner-id UUID] [--target-date ISO] [--color HEX] [--icon NAME] [--json]
lebop initiative update <id-or-name> [--name] [--description] [--status] [--owner-id UUID] [--clear-owner] [--target-date ISO|null] [--color] [--icon] [--json]
lebop initiative archive <id-or-name> [--yes]      # reversible
lebop initiative unarchive <id-or-name>
lebop initiative delete <id-or-name> [--yes]       # permanent
lebop initiative add-project <initiative> <project> [--sort-order N] [--json]
lebop initiative remove-project <initiative> <project> [--yes] [--json]
```

All six initiative lifecycle commands (`view`/`update`/`archive`/`unarchive`/
`delete` plus `add-project`/`remove-project`) accept `<id-or-name>` — UUID
or exact initiative name, resolved via `resolveInitiativeId`. Name lookup
also surfaces archived initiatives (the `unarchive` and `delete` paths
need this).
`initiative update --clear-owner` clears the owner. It is mutually exclusive
with `--owner-id`.

### 8.11 `initiative-update` — initiative status updates with health

```
lebop initiative-update create <initiative> [--body | --body-file | --stdin] [--health onTrack|atRisk|offTrack] [--json]
lebop initiative-update list <initiative> [--json]
```

Same shape as `project-update`. `<initiative>` accepts a name or UUID.

### 8.12 `cycle` — Linear cycles (iterations)

```
lebop cycle list [--team KEY | --all-teams] [--limit N] [--json]
lebop cycle view <id> [--json]
```

Read-only. Cycle scheduling lives in the Linear UI.

### 8.13 `document` — Linear documents (CRUD)

```
lebop document list [--project NAME-OR-ID] [--limit N] [--json]
lebop document view <id> [--json]
lebop document create <title> (--project NAME-OR-ID | --project-id UUID) [--content | --content-file | --stdin] [--icon NAME] [--json]
lebop document update <id> [--title] [--content | --content-file | --stdin] [--icon] [--json]
lebop document delete <id> [--yes] [--json]
```

First-class lebop document CRUD is project-scoped: `create` requires exactly
one project selector. `--project` accepts a project name or UUID; `--project-id`
is UUID-only and skips name lookup. `view` includes the full content body. Linear also
supports issue-scoped documents; lebop exposes those on the research side via
`workspace explore /issues/<id>/documents` and
`workspace fetch /issues/<id>/documents`, but issue/workspace document
creation is not a first-class command.

### 8.14 `agent-session` — Linear agent sessions (read-only)

```
lebop agent-session list [--status NAME] [--issue-id UUID] [--limit N] [--json]
lebop agent-session view <id> [--json]
```

Read-only access to Linear's first-class agent-activity surface. lebop
doesn't create or end sessions; that's the agent's job.

### 8.15 `team` — team-scoped operations

```
lebop team members [team-key] [--all] [--json]
lebop team get <key-or-id> [--json]
lebop team workflow-states [team-key] [--json]
```

`get` fetches one team (with its default workflow-state) by key or UUID;
mirrors the MCP `get_team` tool. `workflow-states` lists the team's
workflow states by type (Triage / Backlog / Started / Completed /
Cancelled), useful for resolving `--state` arguments. `team create /
delete / autolinks` are managed in the Linear UI. Plural `lebop teams`
remains the canonical workspace-wide list.

### 8.16 `label` — manage Linear labels

```
lebop label list [--team KEY | --workspace-only | --all] [--json]
lebop label create <name> [--team KEY | --workspace-scoped] [--color HEX] [--description TEXT] [--json]
lebop label delete <name-or-id> [--team KEY] [--scope team|workspace] [--yes] [--json]
```

Labels are either team-scoped (have a `team`) or workspace-scoped (no team).
`list` defaults to the resolved team plus its visible workspace labels;
`--workspace-only` filters to labels with no team scope; `--all` shows
everything the token can see. `delete` accepts either a name or a UUID
directly. Name lookup defaults to the resolved team scope; pass
`--scope workspace` for workspace-scoped labels.

### 8.17 `milestone` — project milestones

```
lebop milestone list [--project NAME-OR-ID] [--include-archived] [--json]
lebop milestone view <id> [--json]
lebop milestone create <name> (--project NAME-OR-ID | --project-id UUID) [--description TEXT] [--target-date ISO] [--sort-order N] [--json]
lebop milestone update <id> [--name TEXT] [--description TEXT] [--target-date ISO|null] [--sort-order N] [--project NAME-OR-ID] [--json]
lebop milestone delete <id> [--yes] [--json]
```

Milestones belong to exactly one project. `create` requires exactly one
project selector. `--project` accepts a project name or UUID; `--project-id`
is UUID-only and skips name lookup. `update --target-date null` clears
the date. `update --project NAME-OR-ID` moves a milestone between projects.

### 8.18 `relation` — first-class link mutations

```
lebop relation add <id> <kind> <other> [--yes] [--json]
lebop relation delete <id> <kind> <other> [--yes] [--json]
lebop relation list <id> [--json]
```

Per-pair relation management. Equivalent to `set links` but easier to read
for one-offs and a cleaner shape for MCP tools. Kinds:
`blocks | blocked-by | duplicates | duplicated-by | related`. Use
`lebop raw` for the undocumented `similar` kind.

### 8.19 `set <field> <ID> <value...>`

Single-shot point edit. Resolves names → UUIDs and writes directly to Linear.
There is no local-cache `updatedAt` snapshot or stale-cache guard on these direct
mutations; use `pull` → edit → `push` or reviewed publish when the user needs
the `_server.updated_at` staleness boundary.

| Field | Example | Notes |
|---|---|---|
| `title` | `set title TEAM-1 "new title"` | |
| `state` | `set state TEAM-1 "In Progress"` | exact match (case-insensitive) |
| `priority` | `set priority TEAM-1 urgent` | `urgent\|high\|normal\|low\|none` or `0..4` |
| `estimate` | `set estimate TEAM-1 5` | non-negative number; `null` clears |
| `assignee` | `set assignee TEAM-1 @me` | `@me`, email, name, or `null` |
| `labels` | `set labels TEAM-1 +urgent -area:backend` | **delta syntax** (default); `=foo,bar` exact-replace |
| `parent` | `set parent TEAM-1 TEAM-100` | TEAM-NN identifier; `null` clears |
| `description` | `set description TEAM-1 --description-file ./body.md` | positional value, `--description`, `--description-file`, or `--stdin`; no cache stale guard |
| `project` | `set project TEAM-1 "Billing API v2"` | project name/UUID; `null` detaches |
| `milestone` | `set milestone TEAM-1 "Milestone"` | milestone name/UUID; `null` clears |
| `cycle` | `set cycle TEAM-1 "Cycle 1"` | cycle name/UUID; `null` clears |
| `links` | `set links TEAM-1 --yes +blocks:TEAM-2 -related:TEAM-3` | five kinds: `blocks\|blocked-by\|related\|duplicates\|duplicated-by`; negative deltas require `--yes` |

Refuses `content`; issue descriptions can be edited directly with
`set description` when the caller accepts the no-stale-guard direct-write tradeoff.
Use pull → edit → push or reviewed publish for larger description edits that
need the local `_server.updated_at` stale-write boundary. For issue relations,
use compact `set links` deltas or the first-class `relation add/delete/list`
verb.

MCP `update_issue` supports the same direct issue-update fields as CLI `set`
except `links`, and can set multiple fields in one JSON-RPC call. Use
`labels` for exact label replacement or `labels_add` / `labels_remove` for
label deltas; do not mix exact labels with deltas. CLI `set` edits one field
per invocation and keeps `set links` as relation delta syntax.

**Negative-delta syntax:** `lebop set labels TEAM-1 -foo` Just Works.
`lebop set links TEAM-1 --yes -related:TEAM-2` uses the same parser handling,
but link removals require `--yes` because they delete a relation object.
`argvPrep.ts` auto-inserts a `--` before the first unknown `-TOKEN` so
commander doesn't parse it as an option flag.

### 8.20 `new` — create one issue

```
lebop new --title TEXT [--team KEY] [--project NAME|--project-id UUID]
          [--state NAME] [--priority NAME|0..4] [--label NAME ...]
          [--estimate POINTS] [--assignee me|EMAIL|NAME]
          [--description TEXT | --description-file FILE | --stdin]
          [--json]
```

Creates a single issue. Team metadata auto-refreshes once on label/state/
project miss. Returns the new identifier and URL on stdout.

If `--state` is omitted, the issue lands in the team's default state —
typically `Backlog`, but `Triage` on teams that have triage enabled.
Pass an explicit `--state` (e.g. `--state Backlog`) to avoid the
Triage hop on triage-enabled teams.

Direct-create flags for parent, milestone, and cycle remain planned; create
the issue first, then use `set`, `pull`/`push`, or the reviewed publish
workflow when those fields are needed immediately after creation. Due date is
not shipped as a first-class issue field; use `raw` only when explicitly
needed and after verifying Linear's current mutation shape for the workspace.

### 8.21 `archive` / `unarchive`

```
lebop archive [IDS...] [--bulk-file FILE | --bulk-stdin] [--yes] [--json]
lebop unarchive <IDS...> [--json]
```

Archive supports three input shapes (combinable):

- Positional: `lebop archive TEAM-101 TEAM-102 TEAM-103..TEAM-110 --yes`
- `--bulk-file <path>`: whitespace-separated IDs, one or many per line.
  Lines starting with `#` are treated as comments.
- `--bulk-stdin`: same shape, read from stdin (good for piping from
  `lebop list --json | jq -r '.issues[].identifier' | lebop archive --bulk-stdin --yes`).

Per-id status tracking — partial failures don't stop the run. Ranges
(`TEAM-101..TEAM-105`) work in any source. Unarchive keeps the simpler
positional-only shape (less common bulk use case).

### 8.22 `bulk update` — batch issue field updates

```
lebop bulk update <IDS...> [--team KEY]
                  [--state NAME] [--priority NAME|0..4]
                  [--label NAME ...]
                  [--assignee @me|me|EMAIL|NAME|null]
                  [--estimate N|null]
                  [--project NAME|UUID|null]
                  [--milestone NAME|UUID|null]
                  [--cycle NAME|UUID|null]
                  [--dry-run] [--yes|--confirm] [--json]
```

Applies one identical patch to many issues through Linear's
`issueBatchUpdate`. `--dry-run` resolves IDs and field names but does not
mutate Linear and does not require confirmation. Real mutations require
`--yes` or `--confirm`.

`--label` replaces the full label set with the provided names. Use `set labels`
or MCP `update_issue labels_add` / `labels_remove` for per-issue label deltas.
`--assignee null`, `--estimate null`, `--project null`, `--milestone null`, and
`--cycle null` clear those fields. Team-scoped names (`state`, `label`,
non-viewer assignee, cycle) use the derived team from identifiers unless
`--team` is supplied. If identifiers span multiple teams and the patch needs
team-scoped resolution, pass `--team` explicitly or split the batch by team.

JSON output is a partial-success envelope with `results`, `summary`, and
`cache` refresh status. Successful rows refresh any matching local issue cache
entry; cache refresh failures are reported separately so callers can run
`lebop pull <id> --refresh --yes` after confirming local overwrite is
intended.

`bulk update --from-file` / `--stdin` are not shipped. Use shell expansion,
`jq`, or `archive --bulk-file` for bulk archive-specific file input.

### 8.23 `plan` — declarative authoring

See §9.

### 8.24 `link` — attach a URL to an issue

```
lebop link <issue> <url> [--title TEXT] [--json]
```

Creates an Attachment on the issue with the URL as its target. Common
use: link a PR, design doc, or external bug tracker. `--title` defaults
to the URL.

### 8.25 `attachment` — list/update/delete URL attachments

```
lebop attachment list <issue> [--json]
lebop attachment update <id> [--title TEXT] [--json]
lebop attachment delete <id> --yes [--json]
```

Linear's `AttachmentUpdateInput` supports title changes, not URL changes.
To change an attachment URL, delete the old attachment and create a new one
with `lebop link`.

### 8.26 `schema` — dump Linear's GraphQL schema

```
lebop schema [-o FILE | --out FILE] [--json]
```

Runs the standard introspection query and emits SDL (or raw introspection
JSON with `--json`). Pairs with `lebop raw` for offline schema-aware
development: dump once, point your editor at the SDL, write queries, then
send them via `raw`.

### 8.27 `raw` — GraphQL escape hatch

```
lebop raw <query> [--variables-json FILE | -]
                  [--variable k=v]            # repeatable; @file or JSON-coerced
                  [--query-file FILE]
                  [--paginate]                # auto-walk connections
                  [--allow-mutation]          # required for GraphQL mutations
                  [--yes|--confirm]           # required with --allow-mutation
```

Executes any GraphQL query through the authenticated client. GraphQL mutations
are blocked unless the caller passes `--allow-mutation` plus `--yes` or
`--confirm`. The
explicit-opt-in for edge-case Linear operations (custom fields, audit
history, file/comment attachments, or newly released fields lebop doesn't
wrap) — but the most common needs now
have first-class verbs.

```sh
lebop raw 'query { viewer { id email } }'
echo '{"id":"TEAM-1"}' | lebop raw 'query($id:String!){issue(id:$id){title}}' --variables-json -
lebop raw 'query{teams(first:$first){nodes{id key}pageInfo{hasNextPage endCursor}}}' \
  --variable first=10 --paginate

# `--variable` accepts JSON literals (numbers/booleans/objects) and `@file` paths
lebop raw 'mutation($input:IssueCreateInput!){issueCreate(input:$input){success}}' \
  --variable input=@payload.json \
  --allow-mutation --yes
```

Output is the raw JSON response (or merged `nodes[]` when `--paginate`
walks a connection).

### 8.28 `completions <bash|zsh|fish>` — shell completion

```
lebop completions bash > /usr/local/etc/bash_completion.d/lebop
lebop completions zsh  > "${fpath[1]}/_lebop"   # then: compinit
lebop completions fish > ~/.config/fish/completions/lebop.fish
```

Emits a completion script for the requested shell on stdout. The script
understands **two levels** of the commander tree — top-level commands
(`lebop <TAB>`) and their direct subcommands (`lebop auth <TAB>` →
`login logout list default token whoami set-default-team`). Names + descriptions
are pulled from the live commander tree at runtime, so the script stays
in sync with whatever's registered. Beyond level 2 (positional args, flag
values), completion falls back to file paths.

The bash script soft-depends on the `bash-completion` package for
`_init_completion`; if that helper is missing it degrades gracefully to
the same compgen-only path. macOS users with Homebrew already have it
(`brew install bash-completion@2`); most Linux distros ship it.

### 8.29 `cache` — inspect and maintain the local cache

```
lebop cache status [--team KEY] [--no-remote] [--json]
lebop cache gc [--max-age <days>] [--max-size <MB>] [--hash <H>]
               [--no-dry-run] [--yes] [--no-preserve-cwd] [--json]
```

`cache status` is an alias of top-level `lebop status`. It reports the
current repo's cached issue/project rows, local modifications, and remote
staleness unless `--no-remote` is supplied. Use `--json` for the same
structured status envelope as `lebop status --json`.

Garbage-collects stale per-repo subdirs under `~/.lebop/cache/`.
**Safe by default**: dry-run mode reports candidates without removing, and
the current repo's hash is preserved even if it would otherwise qualify.
Pass `--no-dry-run --yes` to actually delete; pass `--no-preserve-cwd` to
allow eviction of the cwd's repo cache.

Selection rules:

- `--hash <H>` evicts exactly that hash and skips age/size scoring.
- Otherwise candidates are the **union** of `--max-age` (repos whose newest
  file is older than N days; default 30) and `--max-size` (oldest repos
  removed until total cache size is below N MB; default 500).

Output lists each candidate with hash + reason (`age` / `size` /
`explicit`) + size + last-modified, plus before/after totals. `--json`
emits `{ schema_version, dry_run, candidates, removed, totalSizeBeforeMb,
totalSizeAfterMb }`. The same surface is available over MCP as the
`cache_gc` tool.

### 8.30 `lookup` — resolve small Linear identifiers

```
lebop lookup state <team> <name> [--json]
lebop lookup user <email> [--json]
```

Read-only resolvers for agent workflows that need UUIDs before composing
lower-level mutations. State lookup is team-scoped and exact-name
case-sensitive because Linear workflow states live under teams. User lookup
is workspace-scoped by email. Human output exits 1 on miss; `--json` emits
`{ schema_version, state }` or `{ schema_version, user }` with a `null`
payload on miss.

---

## 9. Plan workflow — declarative authoring

A `plan` is a directory of frontmatter-markdown files describing a Linear
**project** + its issues + their relationships. `lebop plan apply` realizes the
whole graph in one idempotent pass.

Plans are **project-rooted** (`_project.md` required). That maps to a Linear
**project** and issues (with parents/links)—not to a Linear **Initiative**
object. Org-level initiatives use `lebop initiative …` / MCP initiative tools
instead; there is no `_initiative.md` plan root.

### 9.1 Why

The `pull → edit → push` loop is great for editing existing issues. For
**new projects / greenfield issue graphs** it's the wrong tool — you'd have
to create issues one at a time, manually wire up `parent:` and `blocks:` after
the fact, and re-do it if you decide to re-name something. `plan apply` lets
you author the whole graph as code, review the plan as a PR, and realize it in
Linear in one call.

### 9.2 Layout

```
plans/billing-api-v2/
├── _project.md             # required: project metadata + content body
├── epic.md                 # top-level issue (optional parent for sub-issues)
├── design.md               # one file per issue
├── impl.md
└── web-ui.md
```

**Filename → slug**: the stem (filename minus `.md`) is the slug used for
intra-plan references. `design.md` → slug `design`. Explicit `slug:`
in frontmatter overrides.

**File order is not load-bearing.** Numeric prefixes (e.g. `01-design.md`) are
a human convention for reading order only.

### 9.3 `_project.md`

```markdown
---
name: Billing API v2
description: "tagline ≤ 255 chars"
icon: Rocket                         # Linear icon name; optional
state: backlog                       # backlog | planned | started | completed | canceled
team: ENG                            # team KEY (not UUID)
linear_id: 88377408-…                # written back by lebop after first apply
---

# Project body.
Full markdown; same as what `lebop pull --project` would produce.
```

Required: `name`, `team`. Optional: `description`, `icon`, `state`,
`linear_id` (written back). Body optional. `icon` is a Linear internal icon
name, not emoji.

### 9.4 Issue files

```markdown
---
title: "Design usage metering API"
state: Backlog                       # state NAME (case-insensitive)
priority: high                       # name (none|urgent|high|normal|low) or 0..4
estimate: 3                          # Linear estimate points; optional
labels:
  - type:feature
  - area:backend
assignee: someone@example.com        # email | name | @me | null
linear_id: TEAM-401                  # written back after first apply
parent: epic                         # optional: slug OR TEAM-NN identifier

blocks:                              # outgoing list of slugs OR TEAM-NN
  - impl
  - TEAM-321
blocked_by:                          # this issue is blocked by...
  - web-ui
related:
  - TEAM-250
duplicates:                          # WARNING: may move this issue to "Duplicate"
  - TEAM-200
duplicated_by:                       # WARNING: may move targets to "Duplicate"
  - 04-canonical
---

# Body markdown — same renderer rules as `lebop pull`.
```

Required: `title`. Optional: everything else. Body optional.

**Parent / sub-issue semantics.** `parent:` accepts a local slug or a bare
`TEAM-NN`. Plan apply sorts topologically so parents are created first;
the validator refuses cycles in the parent chain. On pull, lebop discovers
parent relationships from Linear and writes them back as `TEAM-NN`.

**Estimate.** Numeric points (typically `1/2/3/5/8`). Passed through to
Linear's `estimate` field on create/update.

**Link snake_case** in YAML (`blocked_by`, `duplicated_by`) maps 1:1 to the
`set links` directional kinds (`blocked-by`, `duplicated-by`).

### 9.5 Link reference resolution

Each entry in `blocks: / blocked_by: / related: / duplicates: /
duplicated_by:` is **either**:

- A **local slug** — another issue file in the same plan. Resolved to its
  `linear_id` at apply time (post-create).
- A **Linear identifier** matching `^[A-Z]+-\d+$` — an external issue
  outside the plan. Resolved to its UUID via lookup.

**Heuristic:** matches `TEAM-NN` regex → external; otherwise local slug.
The validator warns if a slug accidentally matches the identifier regex
(e.g. filename `TEAM-fix.md`).

### 9.6 Apply semantics

`lebop plan apply <dir> [--dry-run] [--strict] [--force] [--yes|--confirm]` runs:

1. **Parse + validate.** Frontmatter + body. Fails fast on missing
   `_project.md`, missing required fields, duplicate slugs, malformed
   identifiers, link refs to unknown slugs, parent cycles, YAML errors.
   Warns (non-fatal) on `blocks`/`blocked_by` cycles, `duplicates`/
   `duplicated_by` (Linear may move issues to `Duplicate` state), slugs
   matching the `TEAM-NN` regex, lint warnings on bodies.

2. **Project upsert.** No `linear_id` → `projectCreate`, write returned UUID
   back. Has `linear_id` → diff + `projectUpdate` only on differences.

3. **Issue upsert** (topological — parents first). Per file:
   - No `linear_id` → `issueCreate`, write returned identifier back.
   - Has `linear_id` → fetch remote, diff, `issueUpdate` only on
    differences. Uses the `updatedAt` stale guard; refuse on stale (use
    `--force --yes`).
   - `--strict` + lint warnings on a body → skip with status
     `lint-blocked`.

4. **Link rewrite.** After every issue has `linear_id`, lebop rewrites the
   plan files: each entry in `blocks:`/`blocked_by:`/`related:`/
   `duplicates:`/`duplicated_by:` is translated from slug → `TEAM-XXX` if it
   was a slug. External identifiers untouched. Subsequent applies see only
   real identifiers.

5. **Relations.** For each link entry, call `issueRelationCreate` with
   appropriate type + direction. **Idempotent at the
   `(issueId, relatedIssueId, type)` tuple** — re-runs are safe. **But:**
   Linear enforces at most one relation per issue pair, so adding
   `+related:X` replaces an existing `+blocks:X` or reverse. Last write
   wins per pair (file-by-file order).

6. **Result.** Per-entity status: `✓ created` / `✓ updated` / `· unchanged`
   / `✗ error` / `! stale` / `✗ lint-blocked`. Summary line. `--json` emits
   `{ schema_version: 1, project, issues, relations }`. Exit 1 if any
   entity errored, was stale, or lint-blocked. **Partial failures do NOT
   roll back** — re-running picks up where the prior apply left off
   (`linear_id`s already written).

### 9.7 Other plan verbs

```
lebop plan validate <dir> [--team KEY] [--json]
lebop plan diff     <dir> [--team KEY] [--json]
lebop plan pull     <dir> [--force] [--yes|--confirm] [--include-new] [--team KEY] [--json]
lebop plan lint     <dir> [--fix] [--strict] [--team KEY] [--json]
```

- **`validate`** — parse + semantic checks (hits Linear for team metadata to
  verify label/state/assignee resolution). No writes. Exit 1 on any
  validation error.
- **`diff`** — show drift between plan files and live Linear: per-entity
  field table, body/content patch, per-issue relation `+`/`-` against the
  plan graph. Flags **remote-only issues** that exist in the project but
  aren't in the plan (separate from drift; `--include-new` resolves them).
  Exit 1 on in-plan drift; extra-remote issues do NOT cause exit 1.
- **`pull`** — overwrite local files with remote state. Refuses on in-plan
  drift unless `--force --yes`. `--include-new` imports remote-only issues
  (slug derived from title). Preserves `linear_id`, `team`, and explicit
  `slug:`; replaces all other fields + body. Rewrites link fields to match
  Linear's current relation graph (makes implicit inverses explicit).
- **`lint`** — walks every `.md` in the plan dir (project + issues), runs
  the linter (universal + repo-scoped). `--fix` rewrites in-place;
  `--strict` non-zero on remaining warnings.

### 9.8 Idempotency

A plan can be re-applied repeatedly:

- **Create exactly once per issue.** Once `linear_id` is written back, all
  subsequent applies update instead of create.
- **Updates are diffed field-by-field.** No-op on remote match.
- **Relations idempotent by tuple.** Linear deduplicates on
  `(issueId, relatedIssueId, type)`.
- **Slug references resolved once then rewritten.** After first apply, files
  contain only `TEAM-XXX`.

### 9.9 Team-collaboration hazard

Plan files are git-tracked source of truth, but `linear_id:` is written back
by `plan apply`. **If two teammates both run `plan apply` on the same plan
directory before the writeback commits land in git, you get duplicate
issues in Linear.**

Workflow for shared plans:

1. One person ("first-applier") runs `lebop plan apply <dir>`.
2. **Immediately** commit the writeback (`git add <plan-dir>` → commit →
   push).
3. Everyone else pulls that commit **before** touching the plan.
4. From then on, `apply`/`diff`/`pull` by anyone targets the same Linear
   entities.

Recovery if two people already applied in parallel: archive one issue set via
`lebop archive <ids...> --yes`; clean duplicate projects with `lebop project
delete <project-id> --yes` or MCP `delete_project` with `confirm: true` when
appropriate. Use raw GraphQL only as an escape hatch when no first-class
surface fits. Then rewrite the plan files to reference the keepers'
`linear_id`s.

### 9.10 Out of scope (today)

- Multiple projects per plan directory (one project per dir)
- Issue archiving via plan (delete-a-file is **warn-and-ignore**; use
  `lebop archive` for explicit disposal)
- Comment seeding via plan
- Custom fields, cycle mutations, and file/comment attachments — escape via
  `lebop raw`
- Moving issues between projects via plan
### 9.11 Relationship to the cache

| Concept | Plan apply shares? |
|---|---|
| `~/.lebop/cache/` | **No.** Plan files live wherever the user puts them; they don't participate in `lebop status` / `lebop push`. |
| `_server:` snapshot | **No.** Drift detection uses live remote fetch, not a cached snapshot. |
| `updatedAt` stale guard | **Yes.** Same mechanism on per-issue update. |
| Linter (`lebop lint`) | **Yes.** Run on each body; `--strict` gates. |
| Mutation plumbing | **Yes.** Plan apply composes `issueCreate` + `issueRelationCreate` calls; shares lib code. |

**Design principle:** plan is for **initial authoring**; cache + push is for
**ongoing editing**. After first apply, users can either (a) stay in the
plan and re-apply, or (b) `lebop pull TEAM-XXX` into the cache. Both work;
mixing them in a single session is supported but the cache does not
auto-sync with plan files.

---

## 10. Lint rules

`lebop lint` runs against local markdown (`description.md` / `content.md`
in the cache by default; explicit paths override; plan dirs walked by
`plan lint`). Rules split into **universal** (always on) and **repo-scoped**
(driven by `~/.lebop/config.yaml`).

### 10.1 Universal — Linear renderer quirks

| ID | Rule | Severity | Auto-fix |
|---|---|---|---|
| `L001` | Table cell begins with `\d+\.` (ordered-list marker) | warn | rewrite `N. X` → `Row N — X` |
| `L002` | Table cell begins with `- ` or `* ` (bullet marker) | warn | rewrite to `• X` |
| `L003` | Code fence with 4+ leading spaces | info | — |
| `L005` | Bare URL inside backticks | info | — |
| `L006` | `text` immediately followed by `---` (becomes setext H2 `## text` on push) | warn | insert blank line before `---` |

### 10.2 Repo-scoped — config-driven

| ID | Rule | Source | Auto-fix |
|---|---|---|---|
| `L004` | Issue ref `TEAM-XXX` not bracketed as a markdown link | `conventions.bracket_issue_refs: true` + `workspaces.<workspace-slug>.url_prefix` | rewrite to `[TEAM-XXX](<url-prefix>/issue/TEAM-XXX)` |
| `R001` | `path_rewrites` — matched `from:` substring needs `to:` prefix | `repos.<path>.path_rewrites` | apply prefix |
| `R002` | Required identifier formats | `repos.<path>.required_formats` (regex `pattern` + `suggest` with `$1`-style groups) | per-rule rewrite |

`lebop push` runs lint pre-mutation: warnings always print to stderr;
`--strict` blocks the push and exits 1. `lebop plan apply --strict` skips
issues whose bodies have warnings (status `lint-blocked`).

`applyFixesFixpoint` iterates `lint → applyFixes` until stable, so multiple
rules flagging the same line all get a chance to compose.

---

## 11. Linear API facts (verified)

These are encoded in code; documented here so contributors don't
rediscover.

### 11.1 Auth — native PAK, multi-workspace

- lebop owns auth end-to-end via Linear **personal API keys** (PAK). No
  runtime dependency on `@schpet/linear-cli`.
- `lebop auth login` validates by fetching `viewer + organization` before
  it persists; the organization's `urlKey` becomes the workspace slug.
- Stored at `~/.lebop/auth.json` mode 0600. **Schema v2** (multi-workspace):

  ```jsonc
  {
    "schema_version": 2,
    "workspaces": {
      "acme": {
        "slug": "acme",
        "name": "Acme",
        "url_key": "acme",
        "token": "lin_api_...",
        "viewer": { "id": "...", "email": "...", "name": "..." },
        "created_at": "..."
      }
    },
    "default": "acme"
  }
  ```

  v1 (single-workspace) files are auto-migrated on first read — lebop
  fetches the org urlKey, rewrites the file as v2, and continues.
- Selection: `--workspace` flag → `LEBOP_WORKSPACE` env → auth file
  default → single configured workspace.
- On 401 from any command: clean message, point at `lebop auth login`. No
  silent reauth.
- **Why PAK, not OAuth:** PAK avoids registering an OAuth app, PKCE, a local
  callback server, refresh tokens. Costs one visit to Linear Settings.
  Actor=app OAuth is a future enhancement (§14) when audit-trail noise
  becomes observable.
- `@linear/sdk` `accessToken` vs `apiKey` matters: `accessToken` prepends
  `Bearer ` to the Authorization header; `apiKey` doesn't. PAKs
  (`lin_api_…`) go through `apiKey`; OAuth tokens go through `accessToken`.
  See `linearClientFromToken` in `lib/auth.ts`.

### 11.2 GraphQL shapes that work

Narrow issue read:

```graphql
query ($id: String!) {
  issue(id: $id) {
    id identifier title description priority url updatedAt
    state    { id name }
    assignee { id name }
    project  { id name }
    parent   { id identifier }
    labels   { nodes { id name } }
    relations        { nodes { id type relatedIssue { identifier } } }
    inverseRelations { nodes { id type issue        { identifier } } }
  }
}
```

`Issue(id: "...")` accepts both UUID and identifier. Multi-alias batching is
the cheapest way to read N issues in one round-trip.

Update:

```graphql
mutation ($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { updatedAt } }
}
```

`input` accepts any subset:
`{ description, title, stateId, priority, labelIds, assigneeId, projectId, estimate, parentId }`.

Team metadata (cached per-team, 1h TTL):

```graphql
query ($team: String!) {
  team(id: $team) {
    id
    states  { nodes { id name } }
    labels  { nodes { id name } }
    members { nodes { id name email } }
  }
}
```

Relations:

```graphql
mutation ($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation { id type issue { identifier } relatedIssue { identifier } }
  }
}
# input = { type: IssueRelationType!, issueId: String!, relatedIssueId: String! }
# IssueRelationType ∈ { blocks, related, duplicate, similar }

mutation { issueRelationDelete(id: "<relation-uuid>") { success } }
```

### 11.3 Update semantics

- `issueUpdate.input.labelIds` **replaces** the full label set. `lebop set
  labels` uses `+/-` delta syntax to hide this from callers; `push`
  computes the full target set and submits it.
- `issueUpdate.input.stateId` — `WorkflowState` UUID, not name.
- `issueUpdate.input.assigneeId` — User UUID, not username.
- `projectUpdate.input.content` — markdown body (long form).
- `projectUpdate.input.description` — short tagline, ≤255 chars.
- A team may not have commonly-assumed labels (e.g. `type:fix`) — verify
  against `team.labels` before submitting; surface candidate lists on
  mismatch.
- `identifier` is a **virtual** field — query by `issue(id: "TEAM-123")`
  works with either identifier or UUID, but `IssueFilter.identifier` does
  not exist (don't try to filter by it).
- `issueArchive(id: String!)` takes the **issue UUID**, not the identifier.
- `issueCreate.input.teamId` is a UUID (not the `TEAM` key); same for
  `stateId`, `labelIds`, `assigneeId`, `projectId`.
- `projectCreate` requires `teamIds: [String!]!` and `name`. Everything else
  optional; default state is `backlog`.

---

## 12. Discovered quirks

Facts that cost time on first encounter. **Check here before re-deriving.**

### 12.1 Linear API / SDK

- **`IssueFilter` has no `identifier` field.** `issues(filter: { identifier:
  { in: [...] } })` errors. Workaround: multi-alias query — `issue(id:
  "TEAM-NN")` accepts either UUID or identifier. See
  `lib/pullQuery.ts::buildPullIssuesQuery`.
- **`@linear/sdk` `accessToken` vs `apiKey`** — see §11.1.
- **The `updatedAt` stale guard is entity-level, not field-level.** Any edit
  bumps it, so stale refusal can be a false positive when two callers edited
  unrelated fields between pull and push. Accepted trade-off; `--force --yes`
  is the escape.
- **`issueUpdate.input.labelIds` REPLACES.** See §11.3.
- **Linear's `viewer.name` may equal their email.** Don't assume `name` is
  distinct from `email`.
- **`issueRelationCreate` is server-side idempotent** at the `(issueId,
  relatedIssueId, type)` tuple. Running the same create twice returns the
  existing relation UUID; doesn't duplicate. **Delete takes the relation's
  UUID** (not the issue pair) — for `-blocks:TEAM-X` the implementation
  reads `issue.relations.nodes`, finds the matching relation, then calls
  `issueRelationDelete`.
- **Linear enforces AT MOST ONE relation per issue pair.** Adding
  `+related:TEAM-X` when `+blocks:TEAM-X` already exists **silently
  replaces** it. Same for direction reversal: `+blocked-by:TEAM-X` replaces
  `+blocks:TEAM-X`. Each `+` against the same pair overwrites — last write
  wins. Agents either target different issues per delta or accept the
  override semantics.
- **Creating a `duplicate`-type relation may auto-move both involved issues
  to the `Duplicate` workflow state** (type: `canceled`). Observed
  empirically — probably an internal Linear "mark as duplicate" workflow
  rather than pure GraphQL. Document or warn.
- **`IssueRelationType` includes `similar`** in addition to the documented
  `blocks | related | duplicate`. `set links` deliberately omits it from
  the surface — use `lebop raw` if needed.
- **Linear re-renders markdown on every `issueUpdate` / `projectUpdate`.**
  Common normalizations: blank lines inserted around `---` horizontal-rule
  dividers; `text\n---` reparsed as `## text` setext H2. `push` writes the
  server's normalized form to disk so `_server.*_hash` matches the file
  immediately — earlier versions kept hash drift that pinned `status` on
  "modified" until `--refresh --yes`.
- **Team metadata has a 1h TTL** and doesn't auto-refresh when lebop
  creates new projects/labels/states. Worked around via
  `withFreshMetadataOnMiss` in `lib/resolve.ts` — name → UUID lookups in
  `new` and `set` auto-refresh once on `ResolveError` and retry.
- **`@linear/sdk`'s `client.client.rawRequest` throws on ANY GraphQL error
  and discards `data`.** The thrown error has top-level `data`, `errors`,
  `query`, `type`, `status`, `raw` fields (NOT `response.data` like
  graphql-request's `ClientError`). For multi-alias queries with partial
  errors, successful aliases are LOST. `pull` works around this by falling
  back to per-id `Promise.allSettled` on multi-alias failure.
- **Archive-bug matrix for single-record getters.** Some entity types'
  `*(id:)` queries throw `"Entity not found"` for ARCHIVED rows even
  though the row exists; others surface archived rows transparently. The
  asymmetry is per-entity-type Linear API behavior; not documented in
  Linear's public docs. Lebop probed each (2026-05-12):

  | Entity | `*(id: archived)` | Workaround needed |
  |---|---|---|
  | `initiative` | throws Entity not found | YES — use `initiatives(filter: {id: {eq: $id}}, includeArchived: true, first: 1) { nodes { ... } }` |
  | `projectMilestone` | throws Entity not found | YES — same pattern via `projectMilestones(filter:...)` |
  | `project` | returns archived | no |
  | `document` | returns archived | no |
  | `issue` | returns archived (per §12.1 above) | no |
  | `cycle` / `agentSession` / `team` | not user-archived in normal UX | (unverified) |

  Affected lebop functions (all use the workaround now):
  `src/lib/initiatives.ts` — `getInitiative`, `isInitiativeArchived`,
  `listInitiativeUpdates`; `src/lib/milestones.ts` — `getMilestone`.
  Bound the outer pagination to `first: 1` since the ID filter
  guarantees at-most-one result (also keeps complexity within Linear's
  per-query budget — unbounded outer hit `Query too complex: 16500 >
  10000` in testing).

### 12.2 Tooling / environment

- **`bun link` doesn't put binaries on the PATH agents inherit.** `~/.bun/
  bin` is interactive-shell-only. Agents inherit the PATH of the process
  that started them. Symlink `~/.bun/bin/lebop → /opt/homebrew/bin/lebop`
  (macOS) or `/usr/local/bin/lebop` (Linux) — those dirs are universally
  on PATH. Required install step.
- **Commander treats leading `-` as an option flag in variadic args.**
  `lebop set labels TEAM-1 -type:test` would otherwise fail with `unknown
  option '-type:test'`. Worked around in `lib/argvPrep.ts` —
  `preprocessSetArgv` walks past `set FIELD ID` (respecting known set
  options like `--team` and `--json`) and auto-inserts `--` before the
  first remaining unknown `-TOKEN`. Users can type `-foo` naturally.
- **Bun's default `tsconfig.json` uses `"module": "Preserve"` and
  `"moduleResolution": "bundler"`.** Correct for a bun-native app — not
  `NodeNext`.
- **`client.client.rawRequest(query, variables)` is the public escape
  hatch** in `@linear/sdk`. Both `.client` and `rawRequest` are typed; no
  `@ts-expect-error` needed.

### 12.3 Misc

- **`@schpet/linear-cli` 2.0.0's `linear auth token` returns an OAuth
  bearer**, not a PAK. That's why `--from-schpet` discriminates and routes
  through `accessToken`, not `apiKey`.
- **Sanity probe for any new GraphQL query:** run it through `lebop raw`
  first to confirm schema acceptance before coding the wrapper.

---

## 13. Release surface and validation

The shipped surface in §3 is the public release surface for the `0.0.4`
line: agent-oriented CLI + MCP tooling, reviewed publish, context
materialization, cache/stale-guard workflows, and deliberately skipped
interactive-only ergonomics (see §3 out-of-scope).

### 13.1 Robustness & internal foundations

- ✅ **Lib decoupling pass** — `commands/*.ts` are thin shells over `lib/*.ts`
  with structured returns. No `console.log`/`process.exit` in lib (only
  `prompt.ts`, documented as TTY-only and not imported by MCP code paths).
  The MCP server consumes lib directly.
- ✅ **Structured error taxonomy** — `LebopError` base + `AuthError`,
  `ConfigError`, `ValidationError`, `CASError`, `NetworkError`,
  `RateLimitError`, `PermissionError`, `NotFoundError`,
  `InvalidArgumentsError` (MCP-only,
  emitted by the envelope validator when zod input validation rejects
  unknown keys or type mismatches; carries an `issues[]` array of per-field
  detail). Stable `code` field on every
  error (`"auth_error" | "config_error" | "validation_error" |
  "cas_error" | "network_error" | "rate_limit_error" |
  "permission_error" | "not_found" | "invalid_arguments"`) for programmatic consumers; optional `hint` for
  user-facing remediation. SDK-boundary
  `mapSdkError` (in `lib/errors.ts`) classifies raw `@linear/sdk` failures
  by structured `extensions.code` first, then by message regex — so
  callers don't grep error strings. `PermissionError` covers Linear
  permission failures such as `FORBIDDEN`, `PERMISSION_DENIED`,
  `INSUFFICIENT_PERMISSIONS`, `ACCESS_DENIED`, HTTP 403, and common
  permission-message fallbacks. CLI handler renders
  `error[code]: msg` + `hint:` line; MCP server maps to MCP error
  responses preserving `code` + `hint`.
- ✅ **Cursor-safe pagination primitives and surfaced continuations** —
  `lib/paginate.ts` exposes `paginateConnection` (SDK) and `paginateRaw`
  (GraphQL). Cursor-backed issue, project, and workspace discovery surfaces
  expose continuation tokens. Some PM-object list commands remain bounded by
  `--limit` without a user-facing cursor; those surfaces should be treated as
  capped result sets, not complete inventories.
- ✅ **Retry + rate-limit handling** at the SDK boundary — `lib/retry.ts`
  classifies thrown errors (`rate-limit` / `transient` / `non-retryable`)
  and applies `Retry-After` / reset-aware delays where Linear provides them,
  falling back to exponential backoff with ±20% jitter on the first two.
  Every SDK call routed through `withClient` in `lib/sdk.ts` gets it for
  free. The SDK transport hook observes rate-limit/complexity headers for
  both raw GraphQL calls and generated SDK model calls. `RateLimitError`
  after the retry budget is exhausted includes structured `details` when
  Linear exposed budget headers; `NetworkError` for transient failures.
- ✅ **`status` shows "stale (remote newer)"** — `lebop status` queries
  remote `updatedAt` for every clean entry (`--no-remote` to skip);
  staleness surfaces as its own bucket in human + JSON output. Same path
  via the `cache_status` MCP tool with the `check_remote` flag (default
  true). `lib/cache.ts` exposes the underlying primitive.
- ✅ **CLI integration tests** — `tests/integration/cli.test.ts` shells
  out to the built CLI through a process-spawning harness, exercising
  auth/error/exit-code/JSON shapes. Adds ~30 CLI-level tests on top of
  the lib suite.
- ✅ **Per-issue paginated comment fetch** — comment list/fetch paths page
  through issue comments instead of stopping at the first Linear connection
  page; truncated workspace dossiers include child continuations.

### 13.2 Shipped parity and explicit remaining gaps

The rows below describe the current shipped CLI/MCP surface. Planned gaps are
called out explicitly so agents do not select commands or flags that do not
exist yet. Interactive-only ergonomics remain deliberately out of scope (§3).

| Surface | Shipped now | Remaining / planned |
|---|---|---|
| **Auth** | `auth login`, `auth logout`, `auth list`, `auth default`, `auth token`, `auth whoami`, `auth set-default-team`, top-level `--workspace <slug>` | System keyring storage / `--plaintext` are not shipped; use mode-0600 auth JSON. `auth migrate` is not a command; v1 files auto-migrate on read. |
| **Issues** | `mine`, `unarchive`, `new`, `set` for title/description/state/priority/estimate/assignee/labels/parent/project/milestone/cycle/links; `new` accepts project/state/priority/estimate/labels/assignee/description; MCP `update_issue` supports the same direct issue fields except links, including exact labels plus `labels_add` / `labels_remove`, and can update multiple fields in one call | CLI `set due-date` and direct `set content` are not shipped as point edits. |
| **Issue attachments + links** | `link <issue> <url> [--title]`; `attachment list\|update\|delete` for Linear URL attachments | File upload attachment creation is not shipped. Attachment URL updates are not supported by Linear's update input; delete + relink instead. |
| **List filters** | `--search`, `--unassigned`, `--cycle`, `--milestone`, `--created-after`, `--updated-since`, `--include-archived`, `--all-teams`, `--state-type`; `mine --all-states` | `--search-comments` is not shipped. |
| **Relations** | First-class verb: `relation add\|delete\|list <id> blocks\|blocked-by\|related\|duplicates\|duplicated-by <other>` plus existing `set links` delta syntax; MCP `update_relations` is the one-call batch equivalent for relation deltas | `similar` is intentionally left to `raw`. |
| **Comments** | `comment list`, `comment update`, `comment delete`, `comment add --parent`, `comment add --body-file`, `comment add --stdin` | Comment attachments are not shipped. |
| **Bulk** | `archive --bulk-file`, `archive --bulk-stdin`; `bulk update <identifiers...> --state/--priority/--label/--assignee/--estimate/--project/--milestone/--cycle [--dry-run] [--yes\|--confirm]` | `bulk update --from-file` / `--stdin` is not shipped. Real bulk mutations require `--yes` or `--confirm`; use `--dry-run` to preview without confirmation. |
| **Labels** | `label list\|create\|delete` (workspace + team-scoped) | |
| **Projects** | `project create\|update\|delete\|view`, `project-update create\|list --health` | |
| **Milestones** | `milestone list\|view\|create\|update\|delete --project` | |
| **Initiatives** | `initiative list\|view\|create\|update\|delete\|archive\|unarchive\|add-project\|remove-project`, `initiative-update create\|list --health` | |
| **Cycles** | `cycle list\|view` | Cycle create/update/delete remain via `raw` for now. |
| **Documents** | `document list\|view\|create\|update\|delete` for project-scoped documents; workspace context can explore/fetch issue-scoped documents | Workspace/issue scoped document creation and `--edit` are not shipped. |
| **Workspace context** | `workspace explore`, `workspace fetch` for ls-style discovery and local context dossiers | |
| **Publish workflow** | `publish review --plan <dir>`, `publish review --cache [IDS...] [--project-id UUID...] [--all-modified]`, `publish apply <review-id>` for reviewed plan/cache publishing | |
| **Agent sessions** | `agent-session list\|view` — Linear's first-class agent feature | |
| **Teams** | `teams`, `team members [team-key] [--all]`, `team get <key-or-id>`, `team workflow-states [team-key]` | Team create/delete/autolinks are UI-managed; use raw GraphQL only when explicitly requested. |
| **Schema** | `lebop schema [-o file]` (offline GraphQL schema dump) | |
| **Raw** | `--paginate`, `--variable k=v` (with `@file` for file-backed values) | |
| **Completions** | `lebop completions bash\|zsh\|fish` | |

### 13.3 MCP server (`lebop mcp`) — ✅ shipped

`lebop mcp` runs an MCP server over **stdio** — right shape for binary
distribution and matches Cursor / Claude Desktop / Windsurf expectations.
HTTP+SSE transport is post-release for hosted/multi-user setups.

Minimal MCP client config, using an absolute binary path:

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

- **Auth**: bearer-token via existing `~/.lebop/auth.json`. OAuth dynamic
  client registration (like Linear's hosted MCP) is post-release.
- **Layout**: `src/mcp/server.ts` is boot-only (stdio server + tool
  registration). Tool handlers live in modular `src/mcp/tools/*` and call
  shared `lib/` / surface contracts. Uses `@modelcontextprotocol/sdk`.
- **Per-call workspace selection**: Linear remote tools accept an optional
  `workspace` arg, except local/auth helpers where a workspace override
  would be misleading (`lint_text`, `cache_gc`, `list_workspaces`,
  `set_default_workspace`) and `set_workspace_default_team`, which names
  the target with `workspace_slug`. The shared `safe()` decorator applies
  the override for the duration of one tool call so workspace state does
  not leak into the next call.
- **Repo boundary**: per-call `workspace` is for selecting the authenticated
  Linear workspace for that one request. The local cache/context key is still
  the repo path, so a normal repo checkout should target one Linear workspace;
  use sibling clones when the same codebase must be operated against multiple
  Linear workspaces.
- **Errors**: every tool handler is wrapped with `safe()`, which catches
  thrown errors and serializes via `formatToolError` into
  `{content: [{type, text}], isError: true}` with `LebopError.code` +
  `hint` preserved. MCP clients see the structured taxonomy.

#### Shipped tools (85)

**Workspace context** (2): `explore_linear_workspace`,
`fetch_linear_workspace`

**Publish workflow** (2): `review_linear_changes`,
`publish_linear_changes`

**Issues — list** (1): `list_issues` — matches the CLI list command; pass
assignee "me" plus active_only true for mine semantics in one MCP call, or
pass all_states true / explicit state type filters to change that
active-work default.

**Issues — lifecycle** (5): `get_issue`, `create_issue`, `update_issue`,
`archive_issue`, `unarchive_issue`

**Relations** (4): `add_relation`, `update_relations`, `list_relations`,
`delete_relation`

**Comments** (4): `list_comments`, `add_comment`, `update_comment`,
`delete_comment`

**Labels** (4): `list_labels`, `create_label`, `delete_label`,
`lookup_label_by_name`

**Milestones** (5): `list_milestones`, `get_milestone`, `create_milestone`,
`update_milestone`, `delete_milestone`

**Projects + project-updates** (7): `list_projects`, `get_project`,
`create_project`, `update_project`, `delete_project`,
`list_project_updates`, `create_project_update`

**Initiatives + initiative-updates** (11): `list_initiatives`,
`get_initiative`, `create_initiative`, `update_initiative`,
`archive_initiative`, `unarchive_initiative`, `delete_initiative`,
`initiative_add_project`, `initiative_remove_project`,
`list_initiative_updates`, `create_initiative_update`

**Cycles** (2): `list_cycles`, `get_cycle`

**Documents** (5): `list_documents`, `get_document`, `create_document`,
`update_document`, `delete_document`

**Agent sessions** (2): `list_agent_sessions`, `get_agent_session`

**Teams** (3): `list_teams`, `list_team_members`, `get_team`

**Attachments** (3): `list_attachments`, `update_attachment`,
`delete_attachment`

**Cache loop** (7): `pull_issues`, `pull_project`, `push_changes`,
`cache_status`, `diff_issue`, `diff_project`, `cache_gc`

**Plan workflow** (5): `plan_validate`, `plan_lint`, `plan_apply`,
`plan_diff`, `plan_pull`

**Workspace mgmt** (5): `list_workspaces`, `set_default_workspace`,
`whoami`, `refresh_whoami`, `set_workspace_default_team`

**Bulk** (1): `bulk_update_issues` — dry-run preview or partial-success batch
update with per-row result; the patch is resolved once and applied to every
identifier. Real mutations require `confirm: true`.

**Lookups** (2): `lookup_state_by_name`, `lookup_user_by_email`

**Workflow states** (1): `list_workflow_states`

**Linker** (1): `link_url_to_issue`

**GraphQL escape hatch** (1): `raw_graphql`

**Linter** (2): `lint_files` mirrors `lebop lint` for explicit local markdown
paths or cached markdown for the resolved repo/team, including fix and strict
modes. With `fix: true`, `lint_files` writes safe file fixes and reports
remaining post-fix warnings. `lint_text` runs the in-memory renderer rule set
(`L001`, `L002`, `L003`, `L005`, `L006`) against arbitrary markdown content.
With `fix: true`, `lint_text` returns fixed content, fix pass count, remaining
warning count, and remaining warnings without touching files.

#### MCP tool inventory (85 tools)

The MCP server is intended to be self-sufficient for shipped agent workflows —
agents, including fully sandboxed containers / VMs where Linear's hosted
OAuth-based MCP is not reachable, can drive the main read/context, cache,
publish, plan, and direct-mutation flows without shelling out to the CLI.
Known parity gaps and CLI-only conveniences are called out in this spec rather
than hidden behind broad "every feature" claims.

For list tools with a team scope, omitted `team` resolves the same
configured default team as the CLI. Pass `all_teams: true` on
`list_issues`, `list_projects`, or `list_cycles` when the intended scope is
workspace-wide. `list_labels` defaults to the resolved team scope; pass
`all: true` for every visible label or `workspace_only: true` for workspace
labels only. List responses include explicit scope fields so agents can see
the resolved scope without an extra config call.

Manifest-marked destructive tools require `confirm: true` in addition to host
annotations. This keeps destructive MCP calls deterministic across hosts;
already-absent targets still return their idempotent status after confirmation.

Always-confirm destructive tools include delete tools plus non-delete
destructive tools such as `archive_issue`, `archive_initiative`, and
`initiative_remove_project`. Some otherwise-normal tools require confirmation
only for modes that can overwrite local files, bypass review/staleness checks,
or remove cached state:

| MCP tool | `confirm: true` required when |
|---|---|
| `pull_issues` | `refresh: true` because cached local edits may be overwritten |
| `pull_project` | `refresh: true` because cached project or issue edits may be overwritten |
| `push_changes` | `force: true` and `dry_run` is not true, because staleness protection is bypassed |
| `plan_apply` | `force: true` and `dry_run` is not true, because reviewed remote freshness checks are bypassed for existing entities |
| `plan_pull` | `force: true` because plan files may be overwritten |
| `cache_gc` | `dry_run: false` because cached rows/directories are removed |
| `bulk_update_issues` | `dry_run` is not true because remote issues are mutated |
| `add_relation` | Preflight reports a relation replacement or duplicate side-effect hazard |
| `update_relations` | Any remove delta; add deltas when preflight reports replacement or duplicate side-effect hazards |
| `raw_graphql` | GraphQL mutation operations because they bypass first-class review/validation |

Issue lifecycle: `get_issue`, `create_issue`, `update_issue`,
`archive_issue`, `unarchive_issue`. `update_issue` maps to CLI `set` for
point edits. It supports the same direct issue-update fields as CLI `set`
except `links`, and can update several fields in one call. Like CLI direct
point edits, it writes directly and does not use the local cache `updatedAt`
snapshot.
When inline relation summaries overflow, `get_issue.completeness.relations`
includes a continuation pointing at `list_relations` with the issue identifier.

Workspace context: `explore_linear_workspace`,
`fetch_linear_workspace`. These are the MCP equivalents of `lebop workspace
explore` and `lebop workspace fetch`. `explore_linear_workspace` returns
concise paths and next paths for Linear workspace discovery/search; it does
not return long bodies. Collection/team paths are marked `fetchable: false`;
concrete project, issue, initiative, document, cycle, milestone, and
agent-session paths are fetchable. Top-level project/initiative/issue listings, supported child
listings, and workspace search return `has_more`, `next_cursor`, and page
metadata for cursor continuation. Non-cursor-backed capped collections return
`page.bounded.continuation: "not_available"` so agents know the result is
bounded, not complete. `fetch_linear_workspace` writes bounded project,
issue, initiative, document, cycle, milestone, or agent-session dossiers under
`~/.lebop/context/<repo-hash>/` (or the caller's `to` directory) and
returns a compact manifest. Omitted `include` uses defaults, explicit
`include: []` fetches only the root entity shell, omitted `depth` defaults
to `full`, and truncated manifests include `continuations` with exact
follow-up tool arguments.

Publish workflow: `review_linear_changes`, `publish_linear_changes`.
`review_linear_changes` validates, lints, diffs, dry-runs, and stores a
review record for a plan directory or modified cache rows. Cache sources
use `source: { kind: "cache", identifiers?, project_ids?, all_modified?,
repo_root? }`; pass `identifiers`, `project_ids`, or `all_modified: true`.
Do not combine `all_modified: true` with explicit target selectors.
`publish_linear_changes` accepts the returned `review_id`, refuses if the
reviewed local hash or remote `updatedAt` snapshot changed after review,
publishes through the shared plan/cache apply path, and verifies by
default.

Comments: `list_comments`, `add_comment`, `update_comment`,
`delete_comment`.

Cache loop: `pull_issues`, `pull_project`, `push_changes`,
`cache_status`, `diff_issue`, `diff_project`. All accept an optional `repo_root` path
arg; default behavior uses the MCP server's cwd → git-root resolution
(same as the CLI). `pull_issues` accepts CLI-style identifier ranges such as
`TEAM-101..TEAM-103`. Both `pull_issues` and `pull_project` also accept `to` to use
the same export-only filesystem mode as CLI `pull --to` instead of writing the
cache. `pull_project` mirrors `lebop pull --project-id / --project`: project
names resolve through the live paginated project list for the resolved team,
then the tool writes project metadata/content plus all child issues in one tool
call. `pull_project.extra_identifiers` accepts issue identifiers or ranges to
pull alongside the project in that same call, which is the one-call
project-plus-extra-issues path for agents. `push_changes` handles both issue
and project cache rows;
issue pushes share the CLI field resolver for title, description, state,
priority, estimate, labels, assignee, and parent, while project pushes
cover name, description, icon, state, start date, target date, and content.

Plan workflow: `plan_validate`, `plan_lint`, `plan_apply`, `plan_diff`,
`plan_pull`.
All take a `dir` path arg — canonical filesystem-MCP pattern. Since
lebop's MCP is stdio-only, the server runs in the same filesystem
context as the agent; passing absolute or cwd-relative paths just
works.

PM object coverage: project CRUD, initiative CRUD, label list/create/delete,
milestone CRUD, project-scoped document CRUD, cycle list/view, agent-session
list/view, and team list/detail/member tools (`list_teams`, `get_team`,
`list_team_members`) are shipped in the current release surface; see the
command reference and MCP inventory for exact arguments.

GraphQL escape hatch: `raw_graphql` (with optional `paginate` to walk
top-level connections). Mutations require `allow_mutation: true` and
`confirm: true`. MCP always
returns `{schema_version, data}`; with `paginate: true`, `data` is the merged
GraphQL response data after walking the selected top-level connection.

Workspace management: `list_workspaces`, `set_default_workspace`,
`set_workspace_default_team`, `whoami`, `refresh_whoami`. `whoami` is
read-only cached auth metadata; `refresh_whoami` revalidates against Linear
and persists refreshed viewer/workspace metadata.

Cache maintenance: `cache_gc` — mirrors `lebop cache gc`; reports or
removes stale per-repo subdirs under `~/.lebop/cache/`, dry-run by
default, cwd-repo preserved.

Linter: `lint_files` mirrors `lebop lint` for explicit local markdown paths or
cached markdown in the resolved repo/team, including `fix` and `strict`.
`lint_text` remains the content-string helper for MCP callers that need
in-memory `L001`, `L002`, `L003`, `L005`, and `L006` checks without touching
files. Repo-scoped rules such as `L004`, `R001`, and `R002` require path/repo
context and run through `lint_files` / CLI file lint.

#### CLI-only / exception surfaces (6 commands)

These genuinely don't make sense over JSON-RPC:

- `auth login` — interactive hidden-input prompt for the PAK; MCP can't
  render password input.
- `auth logout` — local credential teardown; keep it an explicit shell-side
  action rather than a remote MCP tool.
- `auth token` — secret-printing escape hatch; intentionally CLI-only.
- `schema` — offline GraphQL schema export for local files/tooling.
- `completions <shell>` — generates a shell script to source.
- `mcp` — the MCP server itself.

#### Out of scope per §3

Team CRUD (`create_team`, `delete_team`) — Linear's API is restrictive
here and the use case for "agent creates a new Linear team" is thin.
Use the Linear UI.

### 13.4 OSS hygiene & distribution

Shipped:

- `LICENSE` (MIT), `CONTRIBUTING.md`
- `.github/workflows/ci.yml` (bun install → biome → tsc → vitest on
  every push/PR)
- `.github/workflows/canary.yml` — daily read smoke against the noxor
  sandbox workspace (read-paths + MCP handshake), plus a write-enabled
  full-surface harness on Monday schedules and `workflow_dispatch` with
  strict JSON report validation. Requires `LEBOP_NOXOR_TOKEN` repo secret
  scoped to the sandbox workspace.
- `bun scripts/live-nox-surface-smoke.mjs` —
  source-checkout-only full-surface live validation harness for the NOX/Noxor
  sandbox.
  Writes reports under ignored `docs/local/` and best-effort
  archives/deletes resources it creates. The harness now records semantic
  assertions for high-risk publish/context/write operations, including
  milestone issue context paths backed by issues it creates during the run.
  Fixture gaps are hard failures for full-surface release runs. The harness
  has an explicit gap allowlist with reasons and expiry dates, but the
  allowlist is for triage only: a release-valid report still requires zero
  gaps.
- `bun scripts/live-nox-surface-smoke.mjs --validate-report <report.json>` —
  source-checkout-only validator for a full live report completed with zero
  failed steps, zero gaps, zero cleanup failures,
  complete required CLI/MCP coverage, complete required semantic assertion
  coverage, and any supplied provenance expectations
  (`LEBOP_LIVE_EXPECT_WORKSPACE`, `LEBOP_LIVE_EXPECT_TEAM`,
  `LEBOP_LIVE_EXPECT_STAMP`, `LEBOP_LIVE_EXPECT_BIN_MODE`,
  `LEBOP_LIVE_EXPECT_VERSION`, `LEBOP_LIVE_EXPECT_BIN_SHA256`).
- `src/lib/toolSurfaceManifest.ts` (derived L2 re-export from
  `SURFACE_OPERATIONS`) and `src/lib/toolBehaviorContracts.ts` — CLI/MCP
  parity plus high-risk behavior contracts used by local tests and live
  report validation.
- `.github/workflows/release.yml` — tag-triggered, builds 4 platform
  binaries (`bun build --compile --target=bun-{darwin,linux}-{x64,arm64}`),
  gates release builds on the full Noxor live report validator, runs the
  compiled Linux x64 full live smoke with `LEBOP_LIVE_EXPECT_BIN_MODE:
  compiled-binary`, validates exact workspace/team/stamp plus binary
  provenance (`version`, SHA-256, `size_bytes`, platform, arch), and attaches
  binaries to a GitHub release with aggregated `SHA256SUMS`
- `.github/ISSUE_TEMPLATE/{bug.yml,feature.yml}` +
  `PULL_REQUEST_TEMPLATE.md`
- `package.json` publish fields: `license`, `author`, `repository`,
  `homepage`, `bugs`, `keywords`, `files`, `typecheck` script
- `scripts/install.sh` — one-liner installer: detects OS+arch, downloads
  the matching binary, verifies SHA256 against `SHA256SUMS`, drops in
  `~/.local/bin` (or `/usr/local/bin` with sudo). Honors
  `LEBOP_VERSION`, `LEBOP_INSTALL_DIR`, `LEBOP_REPO`.
- README badges (CI status, latest release, license, runtime)
- `lebop completions <bash|zsh|fish>` (see §8.28)

Deferred:

- npm publish + Homebrew tap — GitHub Releases + install script is the
  current distribution path. npm + brew are follow-ups after public
  adoption signal.

---

## 14. Future / out of scope

These are deliberately future work:

- **App-actor OAuth** — register a Linear OAuth app; use `actor=app` so
  agent mutations attribute to the app identity (separate from the human
  user) in Linear's audit log. Deferred until audit-trail noise becomes
  observable.
- **MCP HTTP+SSE transport** — for hosted/multi-user MCP scenarios.
- **`lebop new --from <template>`** — template-driven scaffolding.
- **Sort control** on `list` — minor ergonomics.
- **Default-template handling** on `new` (`--no-use-default-template`).
- **`team create` / `delete` / `autolinks`** — rare UI-managed ops; use raw
  GraphQL only when explicitly requested.
- **Comment edit on existing comment via cache** — comments stay read-only
  in the cache; mutate via `comment update` direct command.
- **Per-field or server-side CAS** — Linear API doesn't expose per-field
  versioning or an update precondition; entity-level stale refusal is the safe
  failure mode.
- **Watch mode / autopush** — explicit action only.

---

## 15. Implementation notes

### 15.1 Runtime: Bun + TypeScript (strict)

- Bun runs `.ts` directly — no build step, no `dist/`.
- ~30 ms cold start vs ~150 ms for `tsx`/`ts-node`. Matters for repeated
  `lebop status` invocations.
- `Bun.file` / `Bun.write` for atomic I/O; fewer dependencies.
- `bun build --compile` produces single-file binaries — the GitHub Releases
  distribution path.
- `tsconfig.json` is strict: `noUncheckedIndexedAccess`, `module:
  "Preserve"`, `moduleResolution: "bundler"`.

### 15.2 Dependencies

Runtime:

- `@linear/sdk` — Linear's official TS SDK
- `yaml` (eemeli/yaml) — preserves comments/anchors better than `js-yaml`
- `commander` — CLI arg parsing
- `diff` — unified-diff rendering
- `chalk` — terminal colors

Dev:

- `typescript` — strict
- `vitest` — unit tests
- `@biomejs/biome` — lint + format (one tool; no eslint/prettier)

### 15.3 Cache hashing

`<repo-hash>` = first 12 chars of SHA-256 of the absolute git-root path.
Deterministic, short, keeps multi-repo caches separated.

### 15.4 Atomicity

All cache writes go via temp-file + `rename`. No partial writes visible to a
concurrent reader.

### 15.5 Stale-guard edge cases

- `updatedAt` bumps on any field edit → false-positive conflicts possible
  if someone edits an unrelated field between pull and push. Accepted —
  safer to over-refuse than clobber.
- The guard is **entity-level, not field-level**. Linear's API doesn't expose
  per-field version tokens or mutation-level `expectedUpdatedAt`, so there's
  no way to say "abort only if *this* field changed remotely" or make the
  compare-and-update atomic. Over-refusal is the safe failure mode; tighten
  if/when Linear ships server-side preconditions.
- `--force --yes` is the escape hatch for mutating CLI commands.

### 15.6 JSON output

Commands intended for agent composition accept `--json` unless their
signature says otherwise. Default CLI output is human-readable; `--json`
emits stable structured output suitable for programmatic composition. The
tool-surface manifest and behavior contract tests define the expected CLI/MCP
pairs and any required payload invariants.

CLI and MCP should expose equivalent behavior, but callers should not assume
byte-identical envelopes across mediums unless a specific command/tool
contract says so. Known transport-shaped differences include not-found/error
envelopes and several list/view wrappers while those contracts are being
tightened.

Some JSON/MCP responses include optional `_meta` sidecars. `_meta.linear_api`
is emitted only when Linear response headers exposed API budget data during
that command/tool call. It is additive, may be absent, and must not be used as
a replacement for domain fields such as `has_more`, `next_cursor`,
`truncated`, `completeness`, or fetch `continuations`.

**Intentional CLI/MCP asymmetry — `raw` / `raw_graphql`:** `lebop raw`
prints Linear's raw `response.data` with no `schema_version` wrapper so
callers can pipe directly to `jq`. The MCP `raw_graphql` tool wraps its
payload in an MCP-safe structured response, including `paginate: true`
responses.

### 15.7 Exit code convention

lebop follows a `gh`-style two-code split:

- **`0`** — success.
- **`1`** — runtime or validation failure that surfaced after the CLI
  parser accepted the invocation. Covers `LebopError` subtypes
  (`AuthError`, `ConfigError`, `ValidationError`, `NotFoundError`,
  `RateLimitError`, `PermissionError`, `NetworkError`, `CASError`,
  `InvalidArgumentsError`), Linear API rejections, and explicit
  `process.exitCode = 1` paths like the destructive-delete `--yes`
  gate. This is the default for anything thrown out of an action
  handler.
- **`2`** — command-syntax error rejected by commander's parser
  before any action body ran. Unknown subcommand, unknown option,
  missing required argument, wrong-arity positionals. Routed via
  `exitOverride` in `cli.ts`.

Scripts that only care "did it succeed" should check `$? -eq 0`. Scripts
that want to distinguish "I mis-typed the command" from "the command ran
and failed" can check `$? -eq 2`. The 1-vs-2 boundary is the
parser/action boundary: if commander accepted the argv, you'll see 1;
if commander rejected it, you'll see 2. `--help` and `--version` exit 0.

### 15.8 What NOT to build

- No cache-format schema migrations. If format changes, nuke cache and
  re-pull.
- No offline queue. Push failure = re-run.
- No watch mode / autopush. Explicit action only.

---

## 16. Why not just `@schpet/linear-cli` or the Linear MCP?

**Best for agents, sufficient for humans.** lebop is built around the agent
use case — bulk markdown editing, declarative plans, lint, stale guards, MCP. A
human using lebop interactively gets a competent CLI, but lebop intentionally
skips ergonomics linear-cli does well: `issue start` (state change + branch
creation), `pull-request` (gh-cli wrapper), browser-open shortcuts, jj/git-
aware issue inference.

**For agent-driven work**, lebop replaces both `@schpet/linear-cli` and the
official Linear MCP server. **For solo human work**, pair lebop (bulk + plan
+ agent + stale guard) with linear-cli (interactive single-issue flows it specializes
in).

| | `@schpet/linear-cli` | Linear MCP server | lebop |
|---|---|---|---|
| Shape | Interactive CLI | Hosted MCP tools | Agentic CLI + MCP, bulk + declarative |
| Input | Flags per field | Per-tool params | Markdown files, flags, MCP — caller's choice |
| Round-trip | Per-command | Per-tool-call | Pull → edit → push, plan → diff → pull |
| Mutation batching | Sequential CLI | Sequential tool calls | One call per plan or one multi-alias push |
| Staleness guard | None | None | `updatedAt` check; `--force --yes` to bypass |
| Markdown lint | None | None | 8 rules (in-memory L001/L002/L003/L005/L006 + repo-scoped L004/R001/R002) |
| Declarative planning | Not a goal | Not exposed | **Hero feature** (`plan apply`) |
| GraphQL escape hatch | Yes (`api`) | No | Yes (`raw`) |
| Local cache | No | No | Yes (`~/.lebop/cache/`) |
| Distribution | npm | Hosted | Bun-compiled binaries via GitHub Releases |
| `issue start` / branch creation / `pr` | Yes | No | **Deliberately skipped** — use linear-cli |
| Multi-workspace `--workspace` flag | Yes | N/A (per-server) | Yes |
| File / URL attachments | Yes | No | URL attachment lifecycle; file upload creation remains planned |
| Initiatives + agent-sessions | Yes | No | Yes |

The Linear MCP server's strength is zero-install OAuth in any MCP-aware
tool; lebop's MCP server runs over stdio with bearer-token auth from
`~/.lebop/auth.json`, exposing a wider tool surface including the
differentiators (`raw_graphql`, `plan_*`, `lint_text`, `pull_issues`,
`push_changes` with the stale guard).
