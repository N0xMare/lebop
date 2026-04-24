---
name: lebop
description: Use lebop CLI for any Linear interaction (read/write issues, projects, comments, links, GraphQL escape hatch). Invoke when the user asks about Linear issues/projects, when working in a repo with `lebop` config, or when bulk Linear edits are needed.
---

# lebop — agentic Linear CLI

`lebop` is a CLI that gives you a complete, efficient interface to Linear. Prefer it over `@schpet/linear-cli`, raw GraphQL, the Linear MCP, or the web UI for any Linear operation.

If `which lebop` returns nothing, the tool isn't installed in this environment — fall back to `linear` (schpet's CLI) or tell the user.

---

## Mental model: pick the right verb

| Goal | Verb | Notes |
|---|---|---|
| Find issues by filter | `list` | `--assignee me --state-type started --limit 20` |
| List teams / projects | `teams` / `projects` | seed for `--team` / `--project` |
| **Read** one issue inline | `show <id>` | no cache write; for "what is this?" |
| **Edit** description / project content | `pull <id>` → edit `description.md` → `push` | round-trips through `~/.lebop/cache/` |
| Change one field | `set <field> <id> <value>` | `title | state | priority | labels | assignee | links` |
| Add a comment | `comment <id> --body "…"` (or `--body-file`, `--stdin`) | direct mutation, no cache |
| Link issues | `set links <id> +blocks:<id2>` | also `+blocked-by`, `+related`, `+duplicates`, `+duplicated-by` |
| Create an issue | `new --title "…" [--project … --state … --label …]` | |
| Archive issue(s) | `archive <id…>` | reversible from Linear UI |
| Anything not wrapped | `raw '<graphql>' [--variables-json -]` | escape hatch |
| Lint local markdown for Linear quirks | `lint [paths…] [--fix] [--strict]` | rules below |

`show` vs `pull`: **`show` for reading**, **`pull` for editing**. Don't pull when you're not going to edit — it just clutters the cache.

---

## The pull → edit → push loop

```sh
lebop pull TEAM-101 TEAM-102 TEAM-103     # or TEAM-101..TEAM-103, or --project NAME
# … edit ~/.lebop/cache/<repo-hash>/issues/<id>/description.md and metadata.yaml …
lebop status                              # see what changed
lebop push --dry-run                      # preview mutations
lebop push                                # apply
```

- The cache lives at `~/.lebop/cache/<repo-hash>/`. `pull` prints the exact path.
- `_server:` block in `metadata.yaml` is the snapshot lebop uses for diffing — don't edit it.
- `push` does CAS via `updatedAt`: if remote moved since your pull, push refuses and points you at `pull --refresh`. `--force` bypasses (use deliberately).
- `push` runs the linter automatically: warnings printed to stderr; `--strict` blocks on any.
- After successful push, the cache stays clean immediately — no manual `--refresh` needed.

For one-off edits, skip the cache and use `set`:
```sh
lebop set state TEAM-101 "In Progress"
lebop set priority TEAM-101 urgent
lebop set labels TEAM-101 +urgent -area:backend     # delta syntax, or =a,b,c for exact
lebop set labels TEAM-101 -type:test                # bare `-` works (auto-escaped)
lebop set assignee TEAM-101 @me                     # or null to unassign
lebop set links TEAM-101 +blocks:TEAM-102 +related:TEAM-103
```

---

## --json on every read

`list`, `projects`, `teams`, `show`, `pull` (summary), `status`, `auth whoami`, `lint` all accept `--json` with stable schema (`{ "schema_version": 1, ... }`). Use it whenever you need to programmatically parse the output.

---

## Discovered Linear quirks (don't relearn these)

- **`text` directly above `---` becomes `## text` (setext H2)** on push. Add a blank line before `---` for a horizontal rule. Linter rule **L006** catches this.
- **Table cells starting with `N.` / `- ` / `* `** break the row (Linear parses them as list markers). Linter rules **L001** / **L002** auto-fix to `Row N — text` / `• text`.
- **Linear stores at most ONE relation per issue pair.** `+related:X` after `+blocks:X` silently replaces it; `+blocked-by:X` replaces `+blocks:X`. The mutation returns `success: true` either way. Plan deltas accordingly.
- **`+duplicates:X` / `+duplicated-by:X` may move both issues to state `Duplicate` (type: canceled)** as a Linear workflow side-effect. Avoid casually.
- **`set description` / `set content` are refused** — those go through `pull → edit → push`.
- **Team metadata caches for 1h** but auto-refreshes on first miss — `--project <name>` works for fresh projects without manual nudging.
- **`pull` with mixed valid+invalid IDs reports per-id** (valid succeed, invalid get clean `not found: <id>`). Use exit code to detect partial failure.

---

## When to escape to `raw`

Use `lebop raw 'query…'` when:
- The operation isn't wrapped (cycles, attachments, audit history, custom fields, `similar`-type relations, schema introspection)
- You need a one-off mutation lebop doesn't support
- You want to confirm a GraphQL shape before adding a wrapper

Pass variables via `--variables-json <file>` or `--variables-json -` (stdin).

---

## Declarative project planning — `lebop plan`

For "write the whole initiative in markdown, upload to Linear in one go" workflows:

```
plans/initiative-name/
├── _project.md          # name/team/description/body
├── epic-foo.md          # top-level issue (optional `parent:` for sub-issues)
├── sub-foo-a.md         # has `parent: epic-foo` → nested under epic
└── task-bar.md          # standalone
```

Issue frontmatter keys: `title`, `state`, `priority`, `estimate`, `labels[]`, `assignee`, `parent` (slug or `UE-###`), plus 5 link fields (`blocks`, `blocked_by`, `related`, `duplicates`, `duplicated_by`).

Verbs:
- `lebop plan validate <dir>` — parse + resolve refs, no Linear writes.
- `lebop plan lint <dir> [--fix]` — run the linter on bodies (pre-apply sweep).
- `lebop plan apply <dir> [--dry-run]` — realize in Linear; writes `linear_id:` back to each file.
- `lebop plan diff <dir>` — show local-vs-remote drift (fields + body patch + relations).
- `lebop plan pull <dir> [--force] [--include-new]` — bring remote state back into files; `--include-new` imports project issues not yet in the plan.

Idempotent: re-applying a plan that matches Linear reports all `unchanged`. Slug references get rewritten to `UE-###` after first apply.

## Team collaboration (critical hazard)

Plan files are git-tracked **source of truth**, but `linear_id:` is written back by `apply`. If two teammates both run `apply` on the same plan directory **before the writeback commits land in git**, you get **duplicate issues in Linear** (each apply creates fresh issues with no shared identifier).

**Workflow for shared plans:**
1. One person ("first-applier") runs `lebop plan apply <dir>`.
2. **Immediately** commit the writeback (`git add <plan-dir>` + commit + push).
3. Everyone else pulls that commit BEFORE touching the plan.
4. From then on, any apply/diff/pull targets the same Linear entities.

If two people already applied in parallel: archive one set via `lebop archive <ids...>` + `lebop raw projectArchive`, then rewrite the plan files to reference the keepers' `linear_id:`s.

## When to NOT use lebop

- Pure UI flows (browser-open, branch-name generation, interactive pickers) — `@schpet/linear-cli` (`linear`) is better for those.
- The user explicitly asks for the Linear web UI or another tool.
