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
single-shot ops. CAS via `updatedAt` catches races at push time. The agent
edits files (or calls MCP tools); lebop owns the transport.

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
| Adding a label requires 3 round-trips (team labels → issue labels → full-replacement submit); `labelIds` REPLACES | boilerplate |
| Linear silently mutates markdown — table cells starting with `1.` get `\n\n` injected (ordered-list-marker quirk) | invisible until push → fetch → diff |
| No CAS / staleness protection — `issueUpdate` has no `expectedUpdatedAt` | silent clobber risk |
| `linear issue view` returns 3 KB of JSON for 300 bytes of description | context bloat |

Goal: collapse the agent workflow from "N round-trips per field" to "pull
once → edit files → push once," and provide first-class verbs for everything
the bulk loop doesn't cover (single-shot edits, comments, lifecycle ops,
declarative authoring).

---

## 3. Scope

### In scope (shipped today)

| Group | Commands |
|---|---|
| **Auth** | `auth login` (incl. `--from-schpet`), `auth logout`, `auth whoami [--refresh]` |
| **Discovery** | `list`, `projects`, `teams` |
| **Read** | `show <id>` (no cache write) |
| **Bulk loop** | `pull`, `push`, `status`, `diff <id>`, `lint` |
| **Single-shot edit** | `set <field>`, `comment` |
| **Lifecycle** | `new`, `archive` |
| **Declarative authoring** | `plan validate / apply / diff / pull / lint` |
| **Escape hatch** | `raw` |

Plus the runtime substrate:

- Native Linear PAK auth (`~/.lebop/auth.json`, mode 0600)
- Per-repo config at `~/.lebop/config.yaml`
- Local cache of issues / projects / comments / team metadata under
  `~/.lebop/cache/<repo-hash>/`
- CAS via `updatedAt` (refuse push on remote drift; `--force` to bypass)
- Markdown linter with universal renderer rules + repo-scoped rules
- GraphQL escape hatch (`raw`)
- Claude Code skill + slash commands (`claude/skills/lebop/`,
  `claude/commands/`)
- Cursor pagination across all list operations (no silent truncation)
- Structured error taxonomy (`LebopError` + 6 subtypes) — see §13.1

### In scope before public release (see §13)

- **MCP server** (`lebop mcp`) wrapping the lib core
- **Bun-compiled standalone binaries** (single-file, no runtime install)
- **Multi-workspace auth** (`auth list / default / token / migrate`,
  `--workspace` flag, system keyring storage)
- **Full feature parity** with `@schpet/linear-cli` minus interactive-only
  ergonomics — see §13.2 for the complete table
- **First-class Linear PM verbs**: initiatives + initiative-update,
  milestones, cycles (list/view), labels, documents (full CRUD),
  agent-sessions, team members, project-update with `--health`
- **Issue attach** (file upload) and **issue link** (URL attach)
- **Comment edit/delete** + replies + attachments
- **Rich `list` filters** (`--search`, `--unassigned`, `--cycle`,
  `--milestone`, `--created-after`, `--include-archived`, `--all-teams`,
  `--all-states`)
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
- **Conflict merging on CAS** — abort and require explicit `pull --refresh`
- **Comment edit on existing comment via cache** — comments are read-only
  in the cache; mutate via `comment update` direct command
- **Watch mode / autopush** — explicit action only
- **Cache-format schema migrations** — nuke cache and re-pull on format
  change

### Out of scope post-release (genuinely future, not pre-public)

- App-actor OAuth (`actor=app` audit-trail separation)
- MCP HTTP+SSE transport (stdio is the pre-release shape)
- `lebop new --from <template>` template-driven scaffolding
- Sort control on `list`
- Default-template handling on `new`
- `team create / delete / autolinks` (rare ops; `raw` covers)
- Issue delete (`archive` is the supported path; destructive ops via `raw`)

---

## 4. Setup

### 4.1 Prerequisites

- **Bun 1.1+** (`curl -fsSL https://bun.sh/install | bash`)
- A **Linear personal API key** (Linear → Settings → API → Personal API
  keys → Create key)

### 4.2 Install

From source (current; binary distribution lands in v1.0 — see §13):

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
lebop --version       # 0.1.0
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
lebop auth login --token "lin_api_..."
lebop auth login --token-file path/to/token
lebop auth login --from-schpet            # import from @schpet/linear-cli
```

Stored at `~/.lebop/auth.json` (mode 0600, dir 0700). The file supports
multiple workspaces; running `auth login` again with a token for a
different organization adds it as another entry.

```sh
lebop auth list                    # list configured workspaces (default marked *)
lebop auth list --json             # structured records
lebop auth default                 # print current default slug
lebop auth default <slug>          # set the default workspace
lebop auth token [<slug>]          # print API token (handy for `curl`)
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
default_team: TEAM                              # used when no per-repo override matches
workspaces:
  TEAM:
    url_prefix: https://linear.app/your-workspace-slug   # required by L004

repos:
  /Users/you/dev/some-repo:                     # absolute git-root path
    team: TEAM                                  # team override for this repo
    conventions:
      bracket_issue_refs: true                  # L004 linter rule
    path_rewrites:                              # R001 linter rule
      - { from: "crates/", to: "protocol/backend/crates/" }
    required_formats:                           # R002 linter rule (regex)
      - { pattern: '\bpr-(\d+)\b', suggest: '[#$1]', message: "Use [#N] form" }
```

Resolution: cwd → walk up for git root → look up by repo path → fall back to
`default_team`. When cwd isn't in a git repo, the cache is keyed by
`_global` and `default_team` is used.

### 4.5 Claude Code integration (optional)

```sh
./bin/install-claude
```

Symlinks `claude/skills/lebop/SKILL.md` → `~/.claude/skills/lebop/` and the
slash commands (`/lebop-pull`, `/lebop-push`, `/lebop-lint`) into
`~/.claude/commands/`. Re-run anytime — symlinks stay in sync with `git
pull`. Restart Claude Code to pick up the skill.

---

## 5. Architecture

### 5.1 Shape

```
lebop/                                # this repo
├── bin/
│   ├── lebop                         # CLI entry: #!/usr/bin/env bun → src/cli.ts
│   └── install-claude                # symlink installer for claude/skills + commands
├── src/
│   ├── cli.ts                        # commander dispatcher; registers all subcommands
│   ├── commands/                     # thin shells over lib/; one file per top-level verb
│   └── lib/                          # lib core (also consumed by the MCP server)
│       ├── auth.ts                   # PAK persistence + validation
│       ├── sdk.ts                    # singleton LinearClient
│       ├── config.ts                 # cwd → git root → repo config → team
│       ├── cache.ts                  # atomic read/write (temp + rename)
│       ├── resolve.ts                # name ↔ UUID + 1h-TTL team metadata
│       ├── pullQuery.ts              # multi-alias issue query builder
│       ├── pushMutations.ts          # batched issueUpdate / projectUpdate
│       ├── relations.ts              # issueRelation create/delete/find
│       ├── diff.ts                   # field-level diff against _server snapshot
│       ├── build.ts                  # FetchedIssue → IssueMetadata + description
│       ├── expand.ts                 # ID range expansion (TEAM-101..TEAM-109)
│       ├── argvPrep.ts               # auto-insert `--` before negative `set` deltas
│       ├── errors.ts                 # rewriteNotFound translator
│       ├── quirks.ts                 # Linear renderer rules (L001-L006)
│       ├── lint.ts                   # rule runner + fixpoint
│       ├── planParse.ts              # frontmatter splitter + plan-dir walker
│       ├── planTypes.ts              # frontmatter schema + LinkKey mapping
│       ├── planValidate.ts           # slug/link/cycle/lint/state/label checks
│       ├── planApply.ts              # topological project + issue + relation realizer
│       ├── planDiff.ts               # local-vs-remote drift (incl. relations)
│       ├── planPull.ts               # overwrite local from remote
│       ├── prompt.ts                 # hidden-input stdin prompt
│       ├── paths.ts                  # ~/.lebop/ path constants
│       └── types.ts                  # shared types (AuthFile, RepoConfig, etc.)
├── tests/                            # vitest unit tests on pure lib functions
├── examples/plans/getting-started/   # generic example plan
├── claude/
│   ├── skills/lebop/SKILL.md
│   └── commands/lebop-{pull,push,lint}.md
└── docs/
    └── spec.md                       # this file (single source of truth)

~/.lebop/                             # runtime state — never touched by git
├── auth.json                         # PAK + viewer cache (0600)
├── config.yaml                       # optional user config
└── cache/<repo-hash>/
    ├── issues/<IDENTIFIER>/
    │   ├── description.md            # user-editable
    │   ├── metadata.yaml             # user-editable + _server: snapshot
    │   └── comments/<comment-uuid>.md  # read-only; refreshed on pull
    ├── projects/<project-uuid>/
    │   ├── content.md
    │   └── metadata.yaml
    └── _team/<TEAM-KEY>.yaml         # team metadata (1h TTL)
```

`<repo-hash>` = `sha256(absolute-git-root-path).slice(0, 12)`. Deterministic,
short, keeps multi-repo caches separated. Fallback `_global` when cwd isn't
in a git repo.

**Principle:** whatever repo the user's shell is in stays pristine. All
runtime state lives under `~/.lebop/`.

### 5.2 Two surfaces, one lib

The `commands/` layer is intentionally thin — each file parses argv, calls
into `lib/`, and formats output (human or `--json`). The MCP server (v1.0;
§13) consumes the same `lib/` functions and emits MCP-tool-shaped responses.
**No business logic lives in `commands/` or in the MCP layer.**

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
lebop pull --project "Some Project"      # whole project + its issues
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
lebop push              # CAS-protected via updatedAt
lebop push --force      # skip CAS (after manual reconciliation)
lebop push --strict     # block on lint warnings
```

### 6.1 `pull` — fetch entities into the cache

```
lebop pull [IDS...] [--project NAME] [--project-id UUID] [--refresh]
                    [--no-comments] [--to <dir>] [--json]
```

By default writes `description.md` + `metadata.yaml` atomically per entity.
Comments are bundled into `issues/<ID>/comments/<comment-uuid>.md` as
read-only files with YAML frontmatter, because agents routinely need thread
context.

- Refuses overwriting locally-modified entries unless `--refresh`
- `--to <dir>` switches to **export mode**: writes to `<dir>/<id>/` instead
  of the cache, skipping the unpushed-edits guard. `status` and `push` only
  see the canonical cache; `--to` files are leaf copies for "drop issue
  context next to code." A warning is printed to make this clear.
- Per-entity GraphQL errors are tolerated — successful entities still land.

### 6.2 `push` — diff cache vs remote, mutate

```
lebop push [IDS...] [--dry-run] [--force] [--strict] [--json]
```

Per-entity flow:

1. Read local files.
2. Fetch current remote `updatedAt` (batched query across all entities being
   pushed).
3. **CAS:** if remote `updatedAt > local _server.updated_at` → abort this
   entity, report conflict, suggest `lebop pull <ID> --refresh`. `--force`
   skips CAS.
4. Compute field-level diff. Resolve names → UUIDs via cached team metadata.
5. Emit `issueUpdate` / `projectUpdate` with **only changed fields**.
6. Refresh local `_server.*` from the mutation response (Linear normalizes
   markdown server-side; we write the normalized form back so the cache
   stays clean immediately — no hash drift).

Bare `lebop push` pushes everything in the current repo's cache; passing IDs
narrows the set. Field-level diff is load-bearing — don't clobber fields the
agent didn't touch.

### 6.3 `status` — git-like diff against `_server`

```
On team: TEAM  (repo: /path/to/consumer-repo)

Modified locally (4):
  TEAM-101  description, labels
  TEAM-102  description
  TEAM-108  description
  project/<uuid>  content

Clean (5):
  TEAM-103 TEAM-104 TEAM-105 TEAM-106 TEAM-107
```

Computes local-vs-`_server` diffs only. (Detecting "stale: remote newer" is
a v1.0 enhancement — currently you discover staleness at push time.)

### 6.4 `diff <ID>` — unified diff vs live remote

Fetches fresh remote, renders a markdown-aware unified diff for one entity.
Exits 1 on drift (script-friendly "is dirty?" signal). `--json` emits the
structured patch.

### 6.5 `show <ID>` — read inline, no cache write

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
project: Example Project    # by name, for readability
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
  project_name: Example Project
  parent_id: <uuid>
  parent_identifier: TEAM-100
  updated_at: "2026-01-01T00:00:00Z"   # used for CAS
```

On push, everything under `_server:` is ignored except `updated_at` (the
staleness check input). Editable top-level fields — including `estimate`
and `parent` — round-trip cleanly: edit in-place, run `lebop status` to see
the diff, `lebop push` to apply.

### 7.3 `cache/<repo-hash>/projects/<uuid>/content.md`

Project long-form body.

### 7.4 `cache/<repo-hash>/projects/<uuid>/metadata.yaml`

```yaml
name: Example Project
description: "short project tagline (≤255 chars)"
state: started
_server:
  id: <uuid>
  updated_at: "2026-01-01T00:00:00Z"
```

---

## 8. CLI command reference

All commands respect `--team <KEY>` (default from config) and `--json`
(stable, versioned schema: `{ "schema_version": 1, ... }`).

### 8.1 `auth`

```
lebop auth login [--token TOKEN | --token-file FILE | --from-schpet]
lebop auth logout [<slug>]
lebop auth list [--json]
lebop auth default [<slug>]
lebop auth token [<slug>]
lebop auth whoami [<slug>] [--refresh] [--json]
```

See §4.3 for selection rules and the multi-workspace data model.

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
           [--limit N | --limit 0] [--json]
```

Default output: one line per issue, `IDENT  [STATE]  TITLE  (assignee)`.
Default limit 50; `--limit 0` means "no user-specified cap" (the
paginator's safety cap of 10k still applies).

`--search` runs full-text against `searchableContent` (title + body).
`--unassigned` and `--assignee` are mutually exclusive. `--all-teams`
drops the team filter for cross-workspace queries.

### 8.2a `mine` — your assigned work

```
lebop mine [--team KEY | --all-teams]
           [--all-states] [--include-archived]
           [--state-type TYPE] [--label NAME ...] [--priority 0..4]
           [--cycle NAME-OR-ID] [--milestone NAME-OR-ID]
           [--limit N] [--json]
```

Shorthand for `list --assignee me` with a default state filter (active
states only — anything that isn't `completed` or `canceled`). Pass
`--all-states` to include those, or `--state-type` to narrow further.

### 8.3 `projects` / `teams` — discovery

```
lebop projects [--team KEY] [--state STATE] [--json]
lebop teams [--json]
```

Useful for seeding `config.yaml` and discovering the right team key.

### 8.4 `show <ID>` — read inline

See §6.5.

### 8.5 `pull / push / status / diff / lint`

See §6.

### 8.6 `comment` — full CRUD

```
lebop comment add <ID> [--body TEXT | --body-file FILE | --stdin]
                       [--parent COMMENT-UUID]      # reply (threads)
                       [--json]
lebop comment list <ID> [--json]
lebop comment update <COMMENT-UUID> [--body TEXT | --body-file FILE | --stdin] [--json]
lebop comment delete <COMMENT-UUID> [--json]
```

Direct mutations on comments; no cache round-trip. `add` is the new
canonical form for what was previously `lebop comment <id>` — the bare
form is gone, prefix with `add`. `list` is paginated and chronological;
`update`/`delete` take the comment's UUID (visible in `list` output).

### 8.4a `project` — manage Linear projects (CRUD)

```
lebop project list [--team KEY | --all-teams] [--state NAME] [--limit N] [--json]
lebop project view <id> [--json]
lebop project create <name> --team KEY [--description] [--content] [--state] [--start-date] [--target-date] [--json]
lebop project update <id> [--name] [--description] [--content] [--state] [--start-date ISO|null] [--target-date ISO|null] [--json]
lebop project delete <id> [--json]
```

Full project CRUD. `update --start-date null` clears the date.
`view` shows description + content + lead + teams + dates.
The legacy `lebop projects` (plural, list-only) is kept as an alias for
`lebop project list`.

### 8.4b `project-update` — project status updates with health

```
lebop project-update create <project> [--body | --body-file | --stdin] [--health onTrack|atRisk|offTrack] [--json]
lebop project-update list <project> [--json]
```

`<project>` accepts a name or UUID. `--health` is the standard Linear
status flag (mirrors linear-cli).

### 8.4c `initiative` — org-level planning units (CRUD)

```
lebop initiative list [--status NAME] [--archived] [--limit N] [--json]
lebop initiative view <id-or-name> [--json]
lebop initiative create <name> [--description] [--status] [--owner-id UUID] [--target-date ISO] [--color HEX] [--icon NAME] [--json]
lebop initiative update <id> [--name] [--description] [--status] [--owner-id] [--target-date ISO|null] [--color] [--icon] [--json]
lebop initiative archive <id>      # reversible
lebop initiative unarchive <id>
lebop initiative delete <id>       # permanent
lebop initiative add-project <initiative> <project> [--sort-order N] [--json]
lebop initiative remove-project <initiative> <project> [--json]
```

Both `add-project` and `remove-project` accept `<initiative>` and `<project>`
as either a name or a UUID.

### 8.4d `initiative-update` — initiative status updates with health

```
lebop initiative-update create <initiative> [--body | --body-file | --stdin] [--health onTrack|atRisk|offTrack] [--json]
lebop initiative-update list <initiative> [--json]
```

Same shape as `project-update`. `<initiative>` accepts a name or UUID.

### 8.4e `cycle` — Linear cycles (iterations)

```
lebop cycle list [--team KEY | --all-teams] [--limit N] [--json]
lebop cycle view <id> [--json]
```

Read-only. Cycle scheduling lives in the Linear UI.

### 8.5a `label` — manage Linear labels

```
lebop label list [--team KEY | --workspace-only | --all] [--json]
lebop label create <name> [--team KEY | --workspace] [--color HEX] [--description TEXT] [--json]
lebop label delete <name-or-id> [--team KEY] [--json]
```

Labels are either team-scoped (have a `team`) or workspace-scoped (no team).
`list` defaults to the resolved team plus its visible workspace labels;
`--workspace-only` filters to labels with no team scope; `--all` shows
everything the token can see. `delete` accepts either a name (looked up in
the resolved team scope) or a UUID directly.

### 8.5b `milestone` — project milestones

```
lebop milestone list [--project NAME-OR-ID] [--json]
lebop milestone view <id> [--json]
lebop milestone create <name> --project NAME-OR-ID [--description TEXT] [--target-date ISO] [--sort-order N] [--json]
lebop milestone update <id> [--name TEXT] [--description TEXT] [--target-date ISO|null] [--sort-order N] [--project NAME-OR-ID] [--json]
lebop milestone delete <id> [--json]
```

Milestones belong to exactly one project. `update --target-date null` clears
the date. `update --project NAME-OR-ID` moves a milestone between projects.

### 8.6a `relation` — first-class link mutations

```
lebop relation add <id> <kind> <other> [--json]
lebop relation delete <id> <kind> <other> [--json]
lebop relation list <id> [--json]
```

Per-pair relation management. Equivalent to `set links` but easier to read
for one-offs and a cleaner shape for MCP tools. Kinds:
`blocks | blocked-by | duplicates | duplicated-by | related`. Use
`lebop raw` for the undocumented `similar` kind.

### 8.7 `set <field> <ID> <value...>`

Single-shot point edit. Resolves names → UUIDs; uses fresh server-side
`updatedAt` for CAS. No local-cache round-trip.

| Field | Example | Notes |
|---|---|---|
| `title` | `set title TEAM-1 "new title"` | |
| `state` | `set state TEAM-1 "In Progress"` | exact match (case-insensitive) |
| `priority` | `set priority TEAM-1 urgent` | `urgent\|high\|normal\|low\|none` or `0..4` |
| `estimate` | `set estimate TEAM-1 5` | non-negative number; `null` clears |
| `assignee` | `set assignee TEAM-1 @me` | `@me`, email, name, or `null` |
| `labels` | `set labels TEAM-1 +urgent -area:backend` | **delta syntax** (default); `=foo,bar` exact-replace |
| `parent` | `set parent TEAM-1 TEAM-100` | TEAM-NN identifier; `null` clears |
| `links` | `set links TEAM-1 +blocks:TEAM-2 -related:TEAM-3` | five kinds: `blocks\|blocked-by\|related\|duplicates\|duplicated-by` |

Refuses `description` / `content` — those need pull → edit → push because
single-shot makes no sense for multi-line bodies. (`set links` v1.0 will
gain a first-class `relation add/delete/list` verb in addition.)

**Negative-delta syntax:** `lebop set labels TEAM-1 -foo` Just Works —
`argvPrep.ts` auto-inserts a `--` before the first unknown `-TOKEN` so
commander doesn't parse it as an option flag.

### 8.8 `new` — create one issue

```
lebop new --title TEXT [--team KEY] [--project NAME|--project-id UUID]
          [--state NAME] [--priority NAME|0..4] [--label NAME ...]
          [--assignee me|EMAIL|NAME]
          [--description TEXT | --description-file FILE | --stdin]
          [--json]
```

Creates a single issue. Team metadata auto-refreshes once on label/state/
project miss. Returns the new identifier and URL on stdout.

(v1.0 will add `--estimate`, `--parent`, `--milestone`, `--cycle`,
`--due-date`.)

### 8.9 `archive <IDS...>` / `unarchive <IDS...>`

```
lebop archive TEAM-101 TEAM-102 [--json]
lebop unarchive TEAM-101 TEAM-102 [--json]
```

Archives or unarchives one or more issues. Per-id status tracking —
partial failures don't stop the run. Both ID ranges (`TEAM-101..TEAM-105`)
and space-separated lists are supported.

`--bulk-file FILE` / `--bulk-stdin` for large lists is a follow-up.

### 8.10 `plan` — declarative authoring

See §9.

### 8.10a `schema` — dump Linear's GraphQL schema

```
lebop schema [-o FILE | --out FILE] [--json]
```

Runs the standard introspection query and emits SDL (or raw introspection
JSON with `--json`). Pairs with `lebop raw` for offline schema-aware
development: dump once, point your editor at the SDL, write queries, then
send them via `raw`.

### 8.11 `raw` — GraphQL escape hatch

```
lebop raw <query> [--variables-json FILE | -] [--query-file FILE]
```

Executes any GraphQL query/mutation through the authenticated client. The
explicit-opt-in for edge-case Linear operations (cycles, attachments,
custom fields) lebop doesn't model as first-class verbs.

```sh
lebop raw 'query { viewer { id email } }'
echo '{"id":"TEAM-1"}' | lebop raw 'query($id:String!){issue(id:$id){title}}' --variables-json -
lebop raw - --variables-json -    # query and variables both from stdin (delimiter-separated)
```

Output is the raw JSON response.

---

## 9. Plan workflow — declarative authoring

A `plan` is a directory of frontmatter-markdown files describing a Linear
project + its issues + their relationships. `lebop plan apply` realizes the
whole graph in one idempotent pass.

### 9.1 Why

The `pull → edit → push` loop is great for editing existing issues. For
**new** initiatives it's the wrong tool — you'd have to create issues one
at a time, manually wire up `parent:` and `blocks:` after the fact, and
re-do it if you decide to re-name something. `plan apply` lets you author
the whole graph as code, review the plan as a PR, and realize it in Linear
in one call.

### 9.2 Layout

```
plans/some-initiative/
├── _project.md             # required: project metadata + content body
├── 01-design.md            # one file per issue
├── 02-impl.md
└── 03-bench.md
```

**Filename → slug**: the stem (filename minus `.md`) is the slug used for
intra-plan references. `01-design.md` → slug `01-design`. Explicit `slug:`
in frontmatter overrides.

**File order is not load-bearing.** Numeric prefixes are a human convention
for reading order only.

### 9.3 `_project.md`

```markdown
---
name: Some Initiative
description: "tagline ≤ 255 chars"
state: backlog                       # backlog | planned | started | completed | canceled
team: TEAM                           # team KEY (not UUID)
linear_id: 88377408-…                # written back by lebop after first apply
---

# Project body.
Full markdown; same as what `lebop pull --project` would produce.
```

Required: `name`, `team`. Optional: `description`, `state`, `linear_id`
(written back). Body optional.

### 9.4 Issue files

```markdown
---
title: "Chain-aware initial gas pricing"
state: Backlog                       # state NAME (case-insensitive)
priority: high                       # name (none|urgent|high|normal|low) or 0..4
estimate: 3                          # Linear estimate points; optional
labels:
  - type:feature
  - area:relayer
assignee: someone@example.com        # email | name | @me | null
linear_id: TEAM-401                  # written back after first apply
parent: epic-multi-rpc               # optional: slug OR TEAM-NN identifier

blocks:                              # outgoing list of slugs OR TEAM-NN
  - 02-multi-rpc
  - TEAM-321
blocked_by:                          # this issue is blocked by...
  - 03-bench-harness
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

`lebop plan apply <dir> [--dry-run] [--strict]` runs:

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
     differences. CAS via `updatedAt`; refuse on stale (use `--force`).
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
lebop plan pull     <dir> [--force] [--include-new] [--team KEY] [--json]
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
  drift unless `--force`. `--include-new` imports remote-only issues
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

Recovery if two people already applied in parallel: archive one set via
`lebop archive <ids...>` + `lebop raw projectArchive`, then rewrite the
plan files to reference the keepers' `linear_id`s.

### 9.10 Out of scope (today)

- Multiple projects per plan directory (one project per dir)
- Issue archiving via plan (delete-a-file is **warn-and-ignore**; use
  `lebop archive` for explicit disposal)
- Comment seeding via plan
- Custom fields, cycles, attachments — escape via `lebop raw`
- Moving issues between projects via plan
- Whole-graph one-relation-per-pair enforcement at validate time (relies on
  Linear's server behavior + last-write-wins)

### 9.11 Relationship to the cache

| Concept | Plan apply shares? |
|---|---|
| `~/.lebop/cache/` | **No.** Plan files live wherever the user puts them; they don't participate in `lebop status` / `lebop push`. |
| `_server:` snapshot | **No.** Drift detection uses live remote fetch, not a cached snapshot. |
| CAS via `updatedAt` | **Yes.** Same mechanism on per-issue update. |
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
| `L004` | Issue ref `TEAM-XXX` not bracketed as a markdown link | `conventions.bracket_issue_refs: true` + `workspaces.<team>.url_prefix` | rewrite to `[TEAM-XXX](<url-prefix>/issue/TEAM-XXX)` |
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
      "unlink-xyz": {
        "slug": "unlink-xyz",
        "name": "Unlink",
        "url_key": "unlink-xyz",
        "token": "lin_api_...",
        "viewer": { "id": "...", "email": "...", "name": "..." },
        "created_at": "..."
      }
    },
    "default": "unlink-xyz"
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
- **`updatedAt` CAS is entity-level, not field-level.** Any edit bumps it,
  so CAS refusal can be a false positive when two callers edited unrelated
  fields between pull and push. Accepted trade-off; `--force` is the
  escape.
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
  "modified" until `--refresh`.
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

## 13. Roadmap to public release

The shipped surface in §3 is functional and used in production by the
author. The work below polishes lebop into a public open-source tool with
**full feature parity** vs `@schpet/linear-cli` (modulo deliberately-skipped
interactive-only ergonomics — see §3 out-of-scope) and a complete MCP server
that exceeds what Linear's hosted MCP exposes.

Versioning ramps to 1.0.0 only when this section is complete.

### 13.1 Robustness & internal foundations

- ✅ **Lib decoupling pass** — `commands/*.ts` are thin shells over `lib/*.ts`
  with structured returns. No `console.log`/`process.exit` in lib (only
  `prompt.ts`, documented as TTY-only and not imported by MCP code paths).
  The MCP server consumes lib directly.
- ✅ **Structured error taxonomy** — `LebopError` base + `AuthError`,
  `ConfigError`, `ValidationError`, `CASError`, `NetworkError`,
  `RateLimitError`. Stable `code` field for programmatic consumers; `hint`
  for user-facing remediation. CLI handler renders `error[code]: msg` +
  `hint:` line; MCP server maps to MCP error responses.
- ✅ **Cursor pagination everywhere** — `lib/paginate.ts` exposes
  `paginateConnection` (SDK) and `paginateRaw` (GraphQL). All list ops walk
  pages; comments fragment bumped 100→250 with overflow warning.
- ⬜ **Retry + rate-limit handling** at the SDK boundary — wrap rawRequest
  with exponential-backoff on `429` / `RATE_LIMITED`; throw
  `RateLimitError` if exhausted; pair with `NetworkError` for transient
  failures.
- ⬜ **`status` shows "stale (remote newer)"** by querying remote `updatedAt`
  (spec §6.3 promised this; not yet shipped).
- ⬜ **CLI integration tests** under `tests/integration/` against a recorded
  SDK fake. Currently 138 pass at lib level; zero CLI-level tests.
- ⬜ **Per-issue paginated comment fetch** — for the rare >250-comments-per-
  issue case. Today: warning emitted; full pagination is a follow-up.

### 13.2 Feature parity with `@schpet/linear-cli`

Full parity except interactive-only ergonomics deliberately out of scope (§3).

| Surface | Add |
|---|---|
| **Auth** | `auth list`, `auth default`, `auth token`, `auth migrate`, system keyring credential storage with `--plaintext` opt-out, `--workspace <slug>` on every command |
| **Issues** | `mine`, `unarchive`, `set` accepts `estimate` / `parent` / `project` / `milestone` / `cycle` / `due-date`, `new` same. `set description --description-file` (currently refused). |
| **Issue attach + link** | `issue attach <id> <file> [--title --comment]` (file upload), `issue link <id> <url> [--title]` (URL attach) |
| **List filters** | `--search`, `--search-comments`, `--unassigned`, `--cycle`, `--milestone`, `--created-after`, `--include-archived`, `--all-teams`, `--all-states` |
| **Relations** | First-class verb: `relation add\|delete\|list <id> blocks\|blocked-by\|related\|duplicate <other>` (in addition to existing `set links` delta syntax) |
| **Comments** | `comment list`, `comment update`, `comment delete`, `comment add --parent` (replies), `comment add --attach`, `comment --body-file` |
| **Bulk** | `archive --bulk-file`, `archive --bulk-stdin` |
| **Labels** | `label list\|create\|delete` (workspace + team-scoped) |
| **Projects** | `project create\|update\|delete\|view`, `project-update create\|list --health` |
| **Milestones** | `milestone list\|view\|create\|update\|delete --project` |
| **Initiatives** | `initiative list\|view\|create\|update\|delete\|archive\|unarchive\|add-project\|remove-project`, `initiative-update create\|list --health` |
| **Cycles** | `cycle list\|view` (CRUD via `raw` for now) |
| **Documents** | `document list\|view\|create\|update\|delete` (workspace, project, issue scoped; `--edit` opens `$EDITOR`) |
| **Agent sessions** | `agent-session list\|view` — Linear's first-class agent feature |
| **Teams** | `team members [team-key] [--all]` (lists active + optional inactive members) |
| **Help search** | `lebop help-search "..."` (Linear product help passthrough) |
| **Schema** | `lebop schema [-o file]` (offline GraphQL schema dump) |
| **Raw** | `--paginate`, `--variable k=v` (with `@file` for file-backed values) |
| **Completions** | `lebop completions bash\|zsh\|fish` |

### 13.3 MCP server (`lebop mcp`) — ✅ scaffolded

`lebop mcp` runs an MCP server over **stdio** — right shape for binary
distribution and matches Cursor / Claude Desktop / Windsurf expectations.
HTTP+SSE transport is post-release for hosted/multi-user setups.

**Initial vertical slice** (lands with the scaffold; expanded coverage
follows as §13.2 commands ship):

- `list_issues` — wraps `lib/listIssues.ts` (paginates + filters + retries)
- `add_relation` — wraps `lib/relations.ts::createLink` (idempotent at the
  tuple level, so safe to retry)
- `list_relations` — wraps `lib/relations.ts::listRelations`
- `lint_text` — wraps `lib/lint.ts` (lebop differentiator; neither
  linear-cli nor Linear's MCP exposes this)

Per-tool `workspace` arg targets a specific workspace via the existing
`LEBOP_WORKSPACE` env path; defaults to the auth file's `default`.

- **Auth:** bearer-token via existing `~/.lebop/auth.json`. OAuth dynamic
  client registration (like Linear's hosted MCP) is post-release.
- **Tools** (each wraps a `lib/` function — no logic duplication):
  - **Reads:** `list_issues`, `get_issue`, `list_my_issues`, `list_comments`,
    `list_projects`, `get_project`, `list_teams`, `get_team`,
    `list_team_members`, `list_users`, `get_user` (`id: "me"`),
    `list_labels`, `list_milestones`, `list_documents`, `get_document`,
    `list_cycles`, `get_cycle`, `list_issue_statuses`, `get_issue_status`,
    `list_initiatives`, `get_initiative`, `list_initiative_updates`,
    `list_project_updates`, `list_agent_sessions`, `get_agent_session`,
    `search_documentation`.
  - **Writes:** `create_issue`, `update_issue`, `archive_issue`,
    `unarchive_issue`, `create_comment`, `update_comment`,
    `delete_comment`, `create_project`, `update_project`, `delete_project`,
    `create_project_update`, `create_label`, `delete_label`,
    `create_milestone`, `update_milestone`, `delete_milestone`,
    `create_initiative`, `update_initiative`, `archive_initiative`,
    `unarchive_initiative`, `delete_initiative`, `initiative_add_project`,
    `initiative_remove_project`, `create_initiative_update`,
    `create_document`, `update_document`, `delete_document`,
    `add_relation`, `delete_relation`, `attach_file_to_issue`,
    `link_url_to_issue`.
  - **Differentiators** (where lebop exceeds Linear's MCP): `raw_graphql`,
    `lint_text`, `plan_validate`, `plan_apply`, `plan_diff`, `plan_pull`,
    `pull_issue` (cache write), `push_changes` (CAS-guarded), `lebop_diff`
    (single-issue unified diff).
- **Layout:** `src/mcp/server.ts` registers tools → `src/mcp/handlers/*.ts`
  thin wrappers over `lib/`. Uses `@modelcontextprotocol/sdk`.
- **Errors** map `LebopError` → MCP error responses with the same `code`
  field, so MCP clients see the structured taxonomy.
- The same SKILL.md teaches both surfaces; tool docs co-live in the skill
  markdown.

### 13.4 OSS hygiene & distribution

- `LICENSE` (MIT)
- `CHANGELOG.md` (Keep-a-Changelog format), `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1)
- `.github/workflows/ci.yml` (bun install → biome → tsc → vitest)
- `.github/workflows/release.yml` (`bun build --compile --target=
  bun-{darwin,linux}-{x64,arm64}` → 4 platform binaries, attached to
  GitHub releases with SHA256SUMS)
- `.github/ISSUE_TEMPLATE/{bug.yml,feature.yml}` +
  `PULL_REQUEST_TEMPLATE.md`
- `package.json` publish fields: `license`, `repository`, `keywords`,
  `author`, `homepage`, `bugs`, `files`
- README badges, asciinema cast or animated demo
- One-line installer script: `curl -fsSL …/install.sh | sh` — picks the
  right binary, verifies SHA256, drops in `/usr/local/bin/lebop`

**No npm publish, no Homebrew tap at first release** — GitHub Releases +
install script is the single distribution path. npm + brew tap are
candidates for a follow-up release after public adoption signal.

---

## 14. Out of scope post-public-release

These are genuinely future, not pre-release:

- **App-actor OAuth** — register a Linear OAuth app; use `actor=app` so
  agent mutations attribute to the app identity (separate from the human
  user) in Linear's audit log. Deferred until audit-trail noise becomes
  observable.
- **MCP HTTP+SSE transport** — for hosted/multi-user MCP scenarios.
- **`lebop new --from <template>`** — template-driven scaffolding.
- **Sort control** on `list` — minor ergonomics.
- **Default-template handling** on `new` (`--no-use-default-template`).
- **`team create` / `delete` / `autolinks`** — rare ops; `raw` covers.
- **Comment edit on existing comment via cache** — comments stay read-only
  in the cache; mutate via `comment update` direct command.
- **Per-field CAS** — Linear API doesn't expose per-field versioning;
  entity-level CAS is the safe failure mode.
- **Watch mode / autopush** — explicit action only.

---

## 15. Implementation notes

### 15.1 Runtime: Bun + TypeScript (strict)

- Bun runs `.ts` directly — no build step, no `dist/`.
- ~30 ms cold start vs ~150 ms for `tsx`/`ts-node`. Matters for repeated
  `lebop status` invocations.
- `Bun.file` / `Bun.write` for atomic I/O; fewer dependencies.
- `bun build --compile` produces single-file binaries — the public-release
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

### 15.5 CAS edge cases

- `updatedAt` bumps on any field edit → false-positive conflicts possible
  if someone edits an unrelated field between pull and push. Accepted —
  safer to over-refuse than clobber.
- CAS is **entity-level, not field-level**. Linear's API doesn't expose
  per-field version tokens, so there's no way to say "abort only if *this*
  field changed remotely." Over-refusal is the safe failure mode; tighten
  if/when Linear ships per-field versioning.
- `--force` is the escape hatch.

### 15.6 JSON output

Every read command (`list`, `projects`, `teams`, `show`, `pull` summary,
`status`, `diff`, `whoami`) accepts `--json`. Default is human-readable;
`--json` emits a stable, versioned schema (`{ "schema_version": 1, ... }`)
suitable for programmatic composition. Write commands respect `--json` by
emitting per-entity result objects.

### 15.7 What NOT to build

- No cache-format schema migrations. If format changes, nuke cache and
  re-pull.
- No offline queue. Push failure = re-run.
- No watch mode / autopush. Explicit action only.

---

## 16. Why not just `@schpet/linear-cli` or the Linear MCP?

**Best for agents, sufficient for humans.** lebop is built around the agent
use case — bulk markdown editing, declarative plans, lint, CAS, MCP. A
human using lebop interactively gets a competent CLI, but lebop intentionally
skips ergonomics linear-cli does well: `issue start` (state change + branch
creation), `pull-request` (gh-cli wrapper), browser-open shortcuts, jj/git-
aware issue inference.

**For agent-driven work**, lebop replaces both `@schpet/linear-cli` and the
official Linear MCP server. **For solo human work**, pair lebop (bulk + plan
+ agent + CAS) with linear-cli (interactive single-issue flows it specializes
in).

| | `@schpet/linear-cli` | Linear MCP server | lebop |
|---|---|---|---|
| Shape | Interactive CLI | Hosted MCP tools | Agentic CLI + MCP, bulk + declarative |
| Input | Flags per field | Per-tool params | Markdown files, flags, MCP — caller's choice |
| Round-trip | Per-command | Per-tool-call | Pull → edit → push, plan → diff → pull |
| Mutation batching | Sequential CLI | Sequential tool calls | One call per plan or one multi-alias push |
| CAS / staleness | None | None | `updatedAt` check; `--force` to bypass |
| Markdown lint | None | None | 8 rules (L001–L006) + repo-scoped config |
| Declarative planning | Not a goal | Not exposed | **Hero feature** (`plan apply`) |
| GraphQL escape hatch | Yes (`api`) | No | Yes (`raw`) |
| Local cache | No | No | Yes (`~/.lebop/cache/`) |
| Distribution | npm | Hosted | Bun-compiled binaries via GitHub Releases |
| `issue start` / branch creation / `pr` | Yes | No | **Deliberately skipped** — use linear-cli |
| Multi-workspace `--workspace` flag | Yes | N/A (per-server) | Yes (post-pre-release work) |
| File / URL attachments | Yes | No | Yes (post-pre-release work) |
| Initiatives + agent-sessions | Yes | No | Yes (post-pre-release work) |

The Linear MCP server's strength is zero-install OAuth in any MCP-aware
tool; lebop's MCP server runs over stdio with bearer-token auth from
`~/.lebop/auth.json`, exposing a wider tool surface including the
differentiators (`raw_graphql`, `plan_*`, `lint_text`, `pull_issue`,
`push_changes` with CAS).
