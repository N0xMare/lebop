---
name: lebop
description: Use lebop CLI/MCP for supported Linear workspace research and writes: explore/fetch context for issues, projects, initiatives, milestones, cycles, documents, and agent sessions; read/write issues, comments, links, reviewed publish, and GraphQL escape hatch. Invoke for Linear workspace/project/issue/initiative research, repos with `lebop` config, or bulk Linear edits.
---

# lebop — agentic Linear CLI

`lebop` is a CLI that gives you a complete, efficient interface to supported Linear workflows. Prefer it over `@schpet/linear-cli`, raw GraphQL, the Linear MCP, or the web UI for shipped read/write/publish operations.

If `which lebop` returns nothing, report that the binary is missing. Use another Linear tool only when the user explicitly asks for that fallback.

---

## Mental model: pick the right verb

| Goal | Verb | Notes |
|---|---|---|
| Understand a workspace / project / issue / initiative / agent session | `workspace explore` → `workspace fetch` | preferred research path; one ls-style discovery call, then one local dossier; MCP equivalents are `explore_linear_workspace` and `fetch_linear_workspace` |
| Find issues by filter | `list` | `--assignee me --state-type started --limit 20` |
| List teams / projects | `teams` / `projects` | seed for `--team` / `--project` |
| **Read** one issue inline | `show <id>` | no cache write; for "what is this?" |
| **Edit** description / project content | `pull <id>` → edit `description.md` → `push` | round-trips through `~/.lebop/cache/` |
| Change one field | `set <field> <id> <value>` | direct mutation, no local cache `updatedAt` snapshot |
| Add a comment | `comment add <id> --body "…"` (or `--body-file`, `--stdin`; `--parent <comment-id>` for replies) | direct mutation, no cache |
| List comments | `comment list <id>` | paginated, chronological |
| Edit a comment | `comment update <comment-id> --body "…"` | by comment UUID (visible in `comment list`) |
| Delete a comment | `comment delete <comment-id> --yes` | by comment UUID |
| Link issues | `set links <id> +blocks:<id2>` | also `+blocked-by`, `+related`, `+duplicates`, `+duplicated-by` |
| Create an issue | `new --title "…" [--project … --state … --priority … --estimate … --label …]` | |
| Publish a reviewed plan | `publish review --plan <dir>` → `publish apply <review-id>` | safer agent path; refuses if files changed after review |
| Publish reviewed cache edits | `publish review --cache [IDS...] [--project-id UUID...]` → `publish apply <review-id>` | approve-then-apply path for cache edits |
| Archive issue(s) | `archive <id…> --yes` | reversible from Linear UI |
| Anything not wrapped | `raw '<graphql>' [--variables-json -]` | escape hatch; raw mutations require `--allow-mutation --yes` |
| Lint local markdown for Linear quirks | `lint [paths…] [--fix] [--strict]` | rules below |

For broad research, prefer `workspace explore` then `workspace fetch` before calling narrower tools. In MCP, use the matching `explore_linear_workspace` and `fetch_linear_workspace` tools; they expose the same Linear discovery/materialization workflow through JSON-RPC instead of shell commands.
`workspace explore` / `explore_linear_workspace` returns concise Linear paths and `next_cursor` for continuable listings, supported child listings, and searches. Pass the cursor back with `--cursor` or the MCP `cursor` argument to continue the same result set.
`--team` / MCP `team` narrows only project, issue, and cycle searches/listings. For initiatives, documents, milestones, and agent sessions, narrow with `--kind`, concrete paths, child paths, smaller limits, or fetch controls instead.
`workspace fetch` / `fetch_linear_workspace` writes bounded local context dossiers under `~/.lebop/context/<repo-hash>/` by default for concrete project, issue, initiative, document, cycle, milestone, and agent-session paths. Omitted include uses defaults; CLI `--include ""` or MCP `include: []` fetches only the root entity shell; omitted depth defaults to full; fetch `--limit` applies per collection/relation direction; `--to` / MCP `to` writes to a caller-selected directory. Truncated manifests include `continuations` with follow-up tool arguments. These files are for research only; use the cache loop or publish workflow for edits.
When workspace research JSON includes `_meta.linear_api`, use it as Linear API budget telemetry. If request or complexity remaining is low, narrow the next call with a concrete target, `--kind`, smaller explore/fetch `--limit`, fetch `--include`/`--depth`, child paths, or `--team` only for project/issue/cycle discovery.
Bare issue identifiers like `TEAM-101` are accepted directly by both workspace surfaces; agents do not need to rewrite them to `/issues/TEAM-101` before calling CLI or MCP.
Use `/issues/<id>/documents` when the question is specifically about documents attached to one issue.
`show` vs `pull`: **`show` for reading one issue**, **`pull` for editing**. Don't pull when you're not going to edit — it just clutters the cache.

Repo-local cache and context paths assume one Linear workspace per repo checkout. Do not switch `--workspace` inside the same checkout for normal work; use sibling clones when one codebase must be operated against multiple Linear workspaces.

For release validation internals, defer to the repo README/spec. Agents should not treat a normal source-wrapper live run as proof for a compiled release artifact.

---

## The pull → edit → push loop

```sh
lebop pull TEAM-101 TEAM-102 TEAM-103 --team TEAM # or TEAM-101..TEAM-103, or --project NAME / --project-id UUID
# … edit ~/.lebop/cache/<repo-hash>/issues/<id>/description.md and metadata.yaml …
lebop status                              # see what changed
lebop push --dry-run                      # preview mutations
lebop push                                # apply
lebop push --project-id <uuid> --project-id <uuid> # push specific modified cached projects
lebop publish review --cache TEAM-101     # reviewed cache publish
lebop publish review --cache --all-modified # review every modified cache row
lebop publish apply <review-id>           # applies only reviewed cache state
```

- The cache lives at `~/.lebop/cache/<repo-hash>/`. `pull` prints the exact path.
- `_server:` block in `metadata.yaml` is the snapshot lebop uses for diffing — don't edit it.
- Project cache metadata supports `start_date` and `target_date` at top level and under `_server`; edit top-level dates, and use `null` to clear a Linear date.
- `push` uses an `updatedAt` stale guard: if remote moved since your pull, push refuses and points you at `pull --refresh --yes` after local overwrite approval. `--force --yes` bypasses the guard (use deliberately). Linear does not expose mutation-level `expectedUpdatedAt`, so this is not atomic server-side CAS.
- `push` runs the linter automatically: warnings printed to stderr; `--strict` blocks on any.
- After successful push, the cache stays clean immediately — no manual `--refresh` needed.

For one-off edits, skip the cache and use `set`:
```sh
lebop set state TEAM-101 "In Progress"
lebop set priority TEAM-101 urgent
lebop set estimate TEAM-101 3                         # or null to clear points
lebop set description TEAM-101 --description-file ./body.md
lebop set project TEAM-101 "Project Name"             # or null to detach
lebop set milestone TEAM-101 "Milestone"              # or null to clear
lebop set cycle TEAM-101 "Cycle 12"                   # or null to clear
lebop set labels TEAM-101 +urgent -area:backend     # delta syntax, or =a,b,c for exact
lebop set labels TEAM-101 -type:test                # bare `-` works (auto-escaped)
lebop set assignee TEAM-101 @me                     # or null to unassign
lebop set parent TEAM-101 TEAM-100                  # or null to detach from parent
lebop set links TEAM-101 +blocks:TEAM-102 +related:TEAM-103
```

In MCP, use `update_issue` with `labels_add` / `labels_remove` for label deltas, or `labels` for exact replacement.

---

## --json for structured output

Prefer `--json` whenever you need to parse CLI output. The CLI emits stable envelopes (`{ "schema_version": 1, ... }`) for reads and for wrapped write/review commands, including `workspace explore`, `workspace fetch`, `publish review`, `publish apply`, cache/status/diff/push, plan commands, comments, projects, initiatives, documents, cycles, milestones, labels, teams, attachments, agent sessions, lookups, archive/unarchive, and links.

Some envelopes include optional `_meta` sidecars. `_meta.linear_api` is budget visibility from Linear response headers and can be absent; use domain fields such as `has_more`, `next_cursor`, `truncated`, `completeness`, and `continuations` for result completeness.

The main exception is `lebop raw`: it intentionally prints Linear's raw `response.data` so callers can pipe it directly to `jq`. The MCP server always returns JSON text envelopes, including for `raw_graphql`.

---

## Discovered Linear quirks (don't relearn these)

- **`text` directly above `---` becomes `## text` (setext H2)** on push. Add a blank line before `---` for a horizontal rule. Linter rule **L006** catches this.
- **Table cells starting with `N.` / `- ` / `* `** break the row (Linear parses them as list markers). Linter rules **L001** / **L002** auto-fix to `Row N — text` / `• text`.
- **Linear stores at most ONE relation per issue pair.** `+related:X` after `+blocks:X` silently replaces it; `+blocked-by:X` replaces `+blocks:X`. The mutation returns `success: true` either way. Plan deltas accordingly.
- **`+duplicates:X` / `+duplicated-by:X` may move both issues to state `Duplicate` (type: canceled)** as a Linear workflow side-effect. Avoid casually.
- **`set description` is a direct write** — use it for small body edits when no cache stale guard is needed; use `pull → edit → push` or reviewed publish for larger/staleness-protected body edits. `set content` is still refused.
- **Team metadata caches for 1h** but auto-refreshes on first miss — `--project <name>` works for fresh projects without manual nudging.
- **`pull` with mixed valid+invalid IDs reports per-id** (valid succeed, invalid get clean `not found: <id>`). Use exit code to detect partial failure.

---

## When to escape to `raw`

Use `lebop raw 'query…'` when:
- The operation isn't wrapped (audit history, custom fields, `similar`-type relations, schema introspection, or newly released Linear API fields before lebop exposes them)
- You need a one-off mutation lebop doesn't support and explicitly pass `--allow-mutation --yes`
- You want to confirm a GraphQL shape before adding a wrapper

Pass variables via `--variables-json <file>` or `--variables-json -` (stdin).
For MCP, `raw_graphql` mutations require both `allow_mutation: true` and `confirm: true`. Prefer first-class write tools or `publish review` / `publish apply` when available.
Team create/delete/autolink management is intentionally UI-managed; use raw GraphQL for those only when the user explicitly asks for that escape hatch.

For MCP destructive/overwrite modes, pass `confirm: true` when required by the tool: delete/archive-style tools always require it; `bulk_update_issues` requires it unless `dry_run: true`; `pull_issues` / `pull_project` require it with `refresh: true`; `push_changes` and `plan_apply` require it with `force: true` only when `dry_run` is not true; `plan_pull` requires it with `force: true`; `cache_gc` requires it with `dry_run: false`; `add_relation` requires it when preflight reports a replacement or duplicate side-effect hazard; `update_relations` requires it for remove deltas and hazardous add preflights; and `raw_graphql` requires it for GraphQL mutations.

For MCP linting, use `lint_files` when you need CLI-equivalent file/cache lint behavior and `lint_text` when you only have an in-memory markdown string. With `fix: true`, returned warnings and counts are remaining post-fix diagnostics, so do not treat fixed warnings as still outstanding.

---

## Declarative project planning — `lebop plan`

For "author a **Linear project + its issues** as markdown, then realize them in one go" workflows. A plan directory is **project-rooted**: required `_project.md` plus issue files. That maps to a Linear **project** and issues (with parents/links)—not to a Linear **Initiative** object.

**Linear initiatives** (org-level planning units that group projects) are separate: use `lebop initiative …` / MCP initiative tools (create, update, add/remove project, etc.). There is no `_initiative.md` plan root and no declarative initiative tree in `plan apply` today.

```
plans/project-name/
├── _project.md          # required: name/team/description/icon/body → Linear project
├── epic-foo.md          # top-level issue (optional `parent:` for sub-issues)
├── sub-foo-a.md         # has `parent: epic-foo` → nested under epic
└── task-bar.md          # standalone
```

Issue frontmatter keys: `title`, `state`, `priority`, `estimate`, `labels[]`, `assignee`, `parent` (slug or `TEAM-###`), plus 5 link fields (`blocks`, `blocked_by`, `related`, `duplicates`, `duplicated_by`).

Verbs:
- `lebop plan validate <dir>` — parse + resolve refs, no Linear writes.
- `lebop plan lint <dir> [--fix]` — run the linter on bodies (pre-apply sweep).
- `lebop plan apply <dir> [--dry-run] [--force --yes]` — realize in Linear; writes `linear_id:` back to each file. Existing remote updates require fresh `_server.updated_at`; prefer `plan pull` or reviewed publish before using `--force --yes`.
- `lebop plan diff <dir>` — show local-vs-remote drift (fields + body patch + relations).
- `lebop plan pull <dir> [--force --yes] [--include-new]` — bring remote state back into files; `--include-new` imports project issues not yet in the plan.
- `lebop publish review --plan <dir>` — task-shaped review: validate + lint + diff + dry-run, then store a `review_id`.
- `lebop publish apply <review-id>` — publish only the reviewed plan hash, then verify with a post-apply diff.

Idempotent: re-applying a plan that matches Linear reports all `unchanged`. Slug references get rewritten to `TEAM-###` after first apply.

## Team collaboration (critical hazard)

Plan files are git-tracked **source of truth**, but `linear_id:` is written back by `apply`. If two teammates both run `apply` on the same plan directory **before the writeback commits land in git**, you get **duplicate issues in Linear** (each apply creates fresh issues with no shared identifier).

**Workflow for shared plans:**
1. One person ("first-applier") runs `lebop plan apply <dir>`.
2. **Immediately** commit the writeback (`git add <plan-dir>` + commit + push).
3. Everyone else pulls that commit BEFORE touching the plan.
4. From then on, any apply/diff/pull targets the same Linear entities.

If two people already applied in parallel: archive one issue set via `lebop archive <ids...> --yes`; clean duplicate projects with `lebop project delete <project-id> --yes` or MCP `delete_project` with `confirm: true` when appropriate. Use raw GraphQL only as an escape hatch when no first-class surface fits. Then rewrite the plan files to reference the keepers' `linear_id:`s.

## When to NOT use lebop

- Pure UI flows (browser-open, branch-name generation, interactive pickers) — `@schpet/linear-cli` (`linear`) is better for those.
- The user explicitly asks for the Linear web UI or another tool.
