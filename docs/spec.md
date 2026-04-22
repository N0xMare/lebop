# leebop — spec

**Status:** design, pre-implementation
**Kind:** dev tool for agentic linear users
**Layout:** source lives in this repo; runtime state in `~/.leebop/`

## 1. What this is

A personal TypeScript CLI that turns Linear issue/project edits into a local pull → edit → push loop for coding agents. Replaces the "shell out `linear issue update --description-file` N times, manually resolve label UUIDs, discover markdown quirks by breakage" workflow.

One sentence: stateless CLI (Bun runtime) → `@linear/sdk` → markdown + YAML cache under `~/.leebop/cache/<repo-hash>/`. No daemon, no webhooks, no MCP server. Pull is on-demand; CAS via `updatedAt` catches races at push time.

**Core assumption:** the calling agent has filesystem edit primitives (Read/Write/Edit). The whole design rests on materializing Linear state as files so the agent uses its existing text-editing vocabulary instead of a Linear-specific tool surface. If the target agent class is tool-call-only (no filesystem), the shape changes — most likely a thin MCP server wrapping the same verbs and returning content inline. Today (Claude Code and similar coding agents) this assumption holds cleanly; name it explicitly so the condition under which leebop's shape would need to change is visible. See §10.8 for the JSON-output escape hatch that partially covers tool-call-only callers.

## 2. Motivation

Recent bulk-edit session surfaced during project planning/outlining when agents drive `@schpet/linear-cli` directly:

| Pain | Cost |
|---|---|
| No batch ops — N issue updates = N sequential CLI invocations | time + context window |
| `linear project update` has no `--content-file`; requires raw GraphQL + `--variables-json` | friction |
| Label add requires 3 round-trips (team labels → issue labels → full-replacement submit); `labelIds` REPLACES | boilerplate |
| Linear silently mutates markdown — table cells starting with `1.` / `3.` get `\n\n` injected (ordered-list-marker parser quirk) | invisible until push → fetch → diff |
| No CAS / staleness protection — `issueUpdate` has no `expectedUpdatedAt` | silent clobber risk |
| `linear issue view` returns 3 KB of JSON for 300 bytes of description | context bloat |

Goal: collapse the agent workflow from "N round-trips per field" to "pull once → edit files → push once."

## 3. Scope

### In scope
- Per-user CLI `leebop` with subcommands: `pull`, `push`, `status`, `diff`, `lint`
- Local cache of Linear entities as editable markdown + YAML under `~/.leebop/cache/<repo-hash>/`
- Issues: read/write `description`, `title`, `state`, `priority`, `labels`, `assignee`
- Projects: read/write `content`, `description`, `state`
- Comments: read only (v1)
- Per-repo config at `~/.leebop/config.yaml` (default team, path rewrites, conventions)
- CAS via `updatedAt` — refuse push if remote changed since pull
- Markdown linter encoding discovered Linear-renderer quirks
- User-level Claude Code skill at `~/.claude/skills/leebop/SKILL.md`

### Out of scope
- Multi-user collaboration — this is a personal tool
- Any server-side component, daemon, or long-running process
- Linear webhook subscriptions (see §4)
- Local MCP server exposure (see §4)
- Migrating content between Linear workspaces
- UI — CLI + files only
- Replacing `@schpet/linear-cli` for auth — we shell out to it for bootstrap token
- Comment write-path in v1
- Conflict merging — on `updatedAt` mismatch, abort and require explicit `leebop pull --refresh`

## 4. Alternatives rejected

External research surfaced a heavier architecture: local daemon + webhook subscription + MCP server exposing materialized Linear view. Rejected for personal-scale use:

| Rejected | Why | What we do instead |
|---|---|---|
| Long-running daemon | Solo-agent scale, no multi-consumer freshness requirement; process supervision is operational surface for near-zero gain | Stateless CLI, invoked on demand |
| Linear webhook subscription | Push-sync only helps when multiple consumers race edits; single-agent case is tight enough with pull-on-demand. Also requires public endpoint / tunnel | `leebop pull` fetches fresh each run; CAS on push |
| Local MCP server | Reproduces the per-field-round-trip pattern that makes the official Linear MCP slow for agents. Also: some harness setups require per-workspace MCP registration; a CLI works anywhere `PATH` is set | Bundled high-level verbs (`pull`, `push`, `status`, `lint`) |

Adopted from that research: `@linear/sdk` directly (typed GraphQL, schema kept current by Linear), materialized local view, bundled high-level verbs. **App-actor OAuth** deferred to a later phase — see §11.

## 5. Architecture

```
leebop/                                    # this repo — source only
├── package.json                           # "bin": { "leebop": "./bin/leebop" }
├── tsconfig.json                          # strict, noUncheckedIndexedAccess
├── bun.lockb
├── bin/
│   └── leebop                             # #!/usr/bin/env bun → src/cli.ts
├── src/
│   ├── cli.ts                             # dispatcher + subcommand routing
│   ├── commands/
│   │   ├── pull.ts
│   │   ├── push.ts
│   │   ├── status.ts
│   │   ├── diff.ts
│   │   └── lint.ts
│   └── lib/
│       ├── sdk.ts                         # @linear/sdk client + bootstrap auth
│       ├── cache.ts                       # read/write markdown + YAML
│       ├── diff.ts                        # local ↔ remote field-level diffing
│       ├── lint.ts                        # rule runner
│       ├── quirks.ts                      # Linear renderer quirks (rules)
│       ├── config.ts                      # per-repo config resolution
│       └── types.ts                       # shared types
├── tests/
└── docs/
    ├── spec.md
    └── implementation-plan.md

~/.leebop/                                 # runtime state — never touched by git
├── config.yaml                            # user config, keyed by repo path
└── cache/<repo-hash>/
    ├── issues/TEAM-123/
    │   ├── description.md
    │   └── metadata.yaml
    └── projects/<project-uuid>/
        ├── content.md
        └── metadata.yaml

~/.claude/skills/leebop/
└── SKILL.md                               # agent pointer — when to use leebop
```

Principle: whatever repo the user's shell is in stays pristine. All tool runtime state lives under `~/.leebop/`.

## 6. Prior art — facts the implementation must encode

These are verified behaviors. Do not rediscover.

### 6.1 Auth (v1 bootstrap)
`@schpet/linear-cli` already handles OAuth. Get a bearer token via `linear auth token`. Pass it to `@linear/sdk`. Don't reimplement auth. If 401, surface a clean message pointing at `linear auth login`; don't try to reauth ourselves.

### 6.2 Linear markdown renderer quirks

| Quirk | Symptom | Mitigation |
|---|---|---|
| Table cell starts with `\d+\.` → parsed as ordered-list marker, `\n\n` injected | Row renders broken | Rewrite to `Row N —` / `Path N —` or escape as `N\.` |
| Table cell starts with `- ` or `* ` → bullet-list parsing | Row renders broken | Rewrite to `• X` |
| Code fence with 4+ leading spaces → sometimes parsed as indented code, not fence | Indentation lost | Avoid meaningful leading whitespace |
| Bare URL inside backticks — may double-render | Visual only | Flag |
| Bare URLs auto-link — escape with `<url>` for literal text | | Flag if URL-in-code looks odd |

### 6.3 Update semantics verified
- `issueUpdate.input.labelIds` — **replaces** the full label set. Must include all labels to keep.
- `issueUpdate.input.stateId` — WorkflowState UUID, not name.
- `issueUpdate.input.assigneeId` — User UUID, not username.
- `projectUpdate.input.content` — markdown body (long form).
- `projectUpdate.input.description` — short tagline, ≤255 chars.
- A team may not have commonly-assumed labels (e.g. `type:fix`) — verify against `team.labels` before submitting, and surface candidate lists on mismatch.
- `identifier` is a virtual field — query by `issue(id: "TEAM-123")` works with either identifier or UUID.

### 6.4 GraphQL shapes that work

Narrow issue read:
```graphql
query ($id: String!) {
  issue(id: $id) {
    id identifier title description priority url updatedAt
    state { id name }
    assignee { id name }
    project { id name }
    labels { nodes { id name } }
  }
}
```

Batch read (≤ ~10 issues per call is fine):
```graphql
query ($ids: [String!]!) {
  issues(filter: { identifier: { in: $ids } }) { nodes { ... } }
}
```

Write:
```graphql
mutation ($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { updatedAt } }
}
```
`input` accepts any subset: `{ description, title, stateId, priority, labelIds, assigneeId }`.

Team metadata (cache per-team):
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

## 7. File formats

### 7.1 `cache/<repo-hash>/issues/TEAM-123/description.md`
Pure markdown. The only field that round-trips between agent and Linear here. Nothing else in this file.

### 7.2 `cache/<repo-hash>/issues/TEAM-123/metadata.yaml`
```yaml
identifier: TEAM-123
title: "example issue title"
state: Todo                 # by name → resolved to stateId on push
priority: 1                 # 0 none | 1 urgent | 2 high | 3 normal | 4 low
labels:                     # by name → resolved to labelIds on push
  - area:backend
  - type:refactor
assignee: null              # or email / name
project: Example Project    # by name, for readability
# ---- server-owned; do not edit ----
_server:
  id: <uuid>
  url: https://linear.app/<workspace-slug>/issue/TEAM-123/...
  project_id: <uuid>
  updated_at: "2026-01-01T00:00:00Z"   # used for CAS
```

On push: everything under `_server:` is ignored except `updated_at`, which is used for the staleness check.

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

### 7.5 `~/.leebop/config.yaml`
```yaml
default_team: TEAM
workspaces:
  TEAM:
    url_prefix: https://linear.app/<workspace-slug>
repos:
  /path/to/consumer-repo:
    team: TEAM
    path_rewrites:
      - { from: "crates/", to: "protocol/backend/crates/" }
    conventions:
      bracket_issue_refs: true     # require [TEAM-XXX](linear.app/...) form
```

Resolution: detect `cwd` → walk up for git root → look up by repo path → fall back to `default_team` if no match.

## 8. Commands

All commands respect `--team <KEY>` (default from config), `--verbose`, and `--json` (structured output — see §10.8).

### 8.1 `leebop pull [IDS...] [--project NAME] [--project-id UUID] [--refresh]`
Fetch entities into cache; write `description.md` + `metadata.yaml` atomically (temp file + rename).

- `leebop pull TEAM-101` — single
- `leebop pull TEAM-101 TEAM-102 TEAM-103` — list
- `leebop pull TEAM-101..TEAM-109` — inclusive range, same team
- `leebop pull --project "Example Project"` — project + all its issues
- `--refresh` — overwrite local even when unpushed edits exist (warn first)

Default behavior: if local has unpushed edits, refuse. On per-entity GraphQL error, report and continue with the rest.

### 8.2 `leebop push [IDS...] [--dry-run] [--force]`
Diff local cache vs remote; push changed fields only.

- Bare `leebop push` — push all locally-modified entities in current repo's cache
- `leebop push TEAM-101 TEAM-102` — subset
- `--dry-run` — print diff + mutations; no API calls
- `--force` — skip CAS (dangerous; use only after manual reconciliation)

Per-entity flow:
1. Read local files.
2. Fetch current remote `updatedAt` (batched query across all entities being pushed).
3. CAS: remote `updatedAt > local _server.updated_at` → abort this entity, report conflict, suggest `leebop pull <ID> --refresh`.
4. Compute field-level diff. Resolve names → UUIDs (labels, state, assignee) against cached team metadata.
5. Emit `issueUpdate` / `projectUpdate` with **only changed fields**.
6. Refresh local `_server.updated_at` from mutation response.

Field-level diff is load-bearing: don't clobber fields the agent didn't touch. Exit non-zero on any failure; print summary at end.

### 8.3 `leebop status`
Git-like status for the current repo's cache.

```
On team: TEAM  (repo: /path/to/consumer-repo)

Modified locally (4):
  TEAM-101  description, labels
  TEAM-102  description
  TEAM-108  description
  project/<uuid>  content

Clean (5):
  TEAM-103 TEAM-104 TEAM-105 TEAM-106 TEAM-107

Stale (remote newer — needs pull) (0)
```

### 8.4 `leebop diff <ID>`
Unified diff of local vs remote for a single entity. Fetches fresh remote, renders markdown-aware diff.

### 8.5 `leebop lint [PATHS...] [--fix] [--strict]`
Run linter rules against local markdown files (default: all `description.md` / `content.md` in current repo's cache).

- `--fix` applies safe rewrites (the `1. X` → `Row 1 — X` class).
- `--strict` exits non-zero on any warning.
- Split: universal Linear-quirk rules (in `src/lib/quirks.ts`) and repo-scoped rules (loaded from `config.yaml`).
- `leebop push` runs lint first; `--strict` mode blocks the push on warnings.

## 9. Lint rule catalog

### 9.1 Universal (all Linear content)

| ID | Rule | Severity | Auto-fix |
|---|---|---|---|
| `L001` | Table cell begins with `\d+\.` (ordered-list marker) | warn | rewrite `N. X` → `Row N — X` |
| `L002` | Table cell begins with `- ` or `* ` (bullet marker) | warn | rewrite to `• X` |
| `L003` | Code fence with 4+ leading spaces | info | — |
| `L004` | Issue ref `TEAM-XXX` not bracketed as markdown link (when `bracket_issue_refs: true`) | warn (repo-scoped) | rewrite to `[TEAM-XXX](<workspace-url-prefix>/issue/TEAM-XXX)` |
| `L005` | Bare URL inside backticks | info | — |

### 9.2 Repo-specific (config-driven)

| ID | Rule | Source | Auto-fix |
|---|---|---|---|
| `R001` | `path_rewrites` — matched `from:` substring needs `to:` prefix | `config.yaml` | apply prefix |
| `R002` | Required identifier formats | `config.yaml` | per rule |

## 10. Implementation notes

### 10.1 Runtime: Bun + TypeScript (strict)

**Why TypeScript:** `@linear/sdk` is native TS with types mirroring Linear's GraphQL schema. Typed mutations catch field-name typos at build time — the class of bug that eats review time.

**Why Bun:**
- Runs `.ts` directly — no build step, no `dist/`
- ~30 ms cold start vs ~150 ms for `tsx`/`ts-node`; matters when the agent repeatedly runs `leebop status`
- `Bun.file` / `Bun.write` for atomic I/O; fewer deps
- `bun build --compile` available if single-binary distribution ever matters

Fallback: `node ≥ 20` + `tsx` works. Code must stay portable (no Bun-only APIs without a Node-compatible shim).

### 10.2 Dependencies

Runtime:
- `@linear/sdk` — Linear's official TS SDK
- `yaml` (eemeli/yaml) — preserves comments/anchors better than `js-yaml`
- `commander` — CLI arg parsing (or `clipanion` for class-based subcommands)
- `diff` — unified-diff rendering for `leebop diff`
- `chalk` — terminal colors (optional)

Dev:
- `typescript` — strict, `NodeNext` module resolution
- `vitest` — unit + integration
- `@biomejs/biome` — lint + format (one tool; skip eslint/prettier)

### 10.3 SDK client (auth in one layer)

```ts
// src/lib/sdk.ts
import { LinearClient } from "@linear/sdk";
import { execSync } from "node:child_process";

let _client: LinearClient | undefined;

export function linear(): LinearClient {
  if (_client) return _client;
  const token = execSync("linear auth token", { encoding: "utf8" }).trim();
  if (!token) throw new Error("No Linear token. Run `linear auth login` first.");
  _client = new LinearClient({ accessToken: token });
  return _client;
}
```

Typed calls throughout; escape hatch for uncovered fields is `linear().client.rawRequest(query, variables)`.

### 10.4 Distribution

```bash
cd <leebop-repo-root>
bun install
bun link    # symlinks `leebop` into Bun's global bin dir
```

`package.json`:
```json
{
  "name": "leebop",
  "bin": { "leebop": "./bin/leebop" }
}
```

`bin/leebop`:
```sh
#!/usr/bin/env bun
import("../src/cli.ts").then(m => m.run(process.argv.slice(2)));
```

### 10.5 Cache hashing
`<repo-hash>` = first 12 chars of SHA-256 of the absolute git-root path. Deterministic, short, keeps multi-repo caches separated.

### 10.6 Atomicity
All writes go via temp-file + `rename`. No partial writes visible to a reader.

### 10.7 CAS edge cases
- `updatedAt` bumps on any field edit → false-positive conflicts possible if someone edits an unrelated field between pull and push. Accepted — safer to over-refuse than clobber.
- CAS is **entity-level, not field-level**. Linear's API does not expose per-field version tokens, so there's no way to say "only abort if *this* field changed remotely." Over-refusal is the safe failure mode; tighten if/when Linear ships per-field versioning.
- `--force` is the escape hatch.

### 10.8 JSON output mode
Every read command (`pull` summary, `status`, `diff`) accepts `--json` for structured output. Default is human-readable; `--json` emits a stable schema suitable for programmatic composition — other tools, scripts, or tool-call-only agents that can't round-trip through the filesystem. Write commands (`push`) respect `--json` by emitting per-entity result objects in place of the human summary. Keep the schema narrow and versioned (`{ "schema_version": 1, ... }`) — stability matters more than richness.

### 10.9 What NOT to build
- No cache-format schema migrations. If format changes, nuke cache and re-pull.
- No offline queue. Push failure = re-run.
- No watch mode / autopush. Explicit action only.

## 11. Future enhancements (deferred, documented here for continuity)

- **App-actor OAuth** — register a Linear OAuth app and use `actor=app` flow so agent mutations attribute to the app identity, not the human user. Keeps Linear audit log clean and lets agent access be gated/revoked independently. Deferred until audit-trail noise is observable.
- **Comment write-path** — commenting from local files feels awkward; `linear issue comment add` is fine for now. Add if repeatedly useful.
- **Slash commands** — one-liners under `~/.claude/commands/` (`/leebop-pull`, `/leebop-push`, `/leebop-lint`). Add after CLI interface settles.
- **Git pre-commit hook** for leebop's own repo — dogfood the linter on its own fixtures.
- **Bulk issue creation (`leebop new`)** — closes the "new issue" side of the workflow (edit side is covered by pull/push). `leebop new --from template.md --count N` or `leebop new --from issues.yaml` for batch import. Reuses the same markdown + YAML file format as the cache so templates can be drafted and reviewed before push. Deferred to Phase 4+.

## 12. Open questions

These are design decisions deferred to implementation. Record answers in `implementation-plan.md` as they're resolved.

1. **Name resolution on ambiguity** — when two labels/states share a name prefix, how do we behave? Current lean: require exact match; fail with a candidate list.
2. **Cache location when not in a git repo** — fall back to `~/.leebop/cache/_global/` using `default_team`, or refuse? Current lean: global fallback.
3. **Batch size for remote `updatedAt` staleness check** — 10 per query reasonable; benchmark and revisit.
4. **Project-issue relationship on pull** — `--project NAME` pulls issues too by default? Current lean: yes, with `--no-issues` to opt out.
