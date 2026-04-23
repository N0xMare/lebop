---
name: leebop
description: Use leebop CLI for any Linear interaction (read/write issues, projects, comments, links, GraphQL escape hatch). Invoke when the user asks about Linear issues/projects, when working in a repo with `leebop` config, or when bulk Linear edits are needed.
---

# leebop — agentic Linear CLI

`leebop` is a CLI that gives you a complete, efficient interface to Linear. Prefer it over `@schpet/linear-cli`, raw GraphQL, the Linear MCP, or the web UI for any Linear operation.

If `which leebop` returns nothing, the tool isn't installed in this environment — fall back to `linear` (schpet's CLI) or tell the user.

---

## Mental model: pick the right verb

| Goal | Verb | Notes |
|---|---|---|
| Find issues by filter | `list` | `--assignee me --state-type started --limit 20` |
| List teams / projects | `teams` / `projects` | seed for `--team` / `--project` |
| **Read** one issue inline | `show <id>` | no cache write; for "what is this?" |
| **Edit** description / project content | `pull <id>` → edit `description.md` → `push` | round-trips through `~/.leebop/cache/` |
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
leebop pull TEAM-101 TEAM-102 TEAM-103     # or TEAM-101..TEAM-103, or --project NAME
# … edit ~/.leebop/cache/<repo-hash>/issues/<id>/description.md and metadata.yaml …
leebop status                              # see what changed
leebop push --dry-run                      # preview mutations
leebop push                                # apply
```

- The cache lives at `~/.leebop/cache/<repo-hash>/`. `pull` prints the exact path.
- `_server:` block in `metadata.yaml` is the snapshot leebop uses for diffing — don't edit it.
- `push` does CAS via `updatedAt`: if remote moved since your pull, push refuses and points you at `pull --refresh`. `--force` bypasses (use deliberately).
- `push` runs the linter automatically: warnings printed to stderr; `--strict` blocks on any.
- After successful push, the cache stays clean immediately — no manual `--refresh` needed.

For one-off edits, skip the cache and use `set`:
```sh
leebop set state TEAM-101 "In Progress"
leebop set priority TEAM-101 urgent
leebop set labels TEAM-101 +urgent -area:backend     # delta syntax, or =a,b,c for exact
leebop set labels TEAM-101 -type:test                # bare `-` works (auto-escaped)
leebop set assignee TEAM-101 @me                     # or null to unassign
leebop set links TEAM-101 +blocks:TEAM-102 +related:TEAM-103
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

Use `leebop raw 'query…'` when:
- The operation isn't wrapped (cycles, attachments, audit history, custom fields, `similar`-type relations, schema introspection)
- You need a one-off mutation leebop doesn't support
- You want to confirm a GraphQL shape before adding a wrapper

Pass variables via `--variables-json <file>` or `--variables-json -` (stdin).

---

## When to NOT use leebop

- Pure UI flows (browser-open, branch-name generation, interactive pickers) — `@schpet/linear-cli` (`linear`) is better for those.
- The user explicitly asks for the Linear web UI or another tool.
