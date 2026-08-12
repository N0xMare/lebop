---
name: lebop-cli-execution
description: "CLI issue day-loop for Linear: mine/list/show, set/comment/relation, pull-edit-push or publish-cache, archive. Shell + lebop CLI only. Queue execution and safe body edits — not program-scale planning. Personal API key only."
---

# lebop-cli-execution

**One role (CLI):** execute on assigned or targeted Linear issues — queue, point-edit, guarded bodies, comments/relations, archive.

Self-contained. **lebop CLI** only (shell). Machine/TOON default. If `lebop` is missing, stop and report. Do not use MCP tool names here. For multi-project program scope-and-ship, use a program-oriented CLI workflow (plan + initiative), not this day-loop.

## Kernel (always)

- Destructive/overwrite: **`--yes`** where required.
- Stale-guarded: `push` / publish-cache refuse if remote moved; re-pull or deliberate `--force --yes` (skips **all** freshness preflight).
- Multi-ws: pin `--workspace` / `LEBOP_WORKSPACE` / auth default for API + cache paths.
- Large bodies: default **64 KiB** on `show`/views; prefer `--content-file` before editing; never rewrite from truncated text.
- `set description` is a **direct write** (no stale guard) — use pull→push for guarded multi-line bodies.

## When to use

- Work my queue / what’s in progress for me
- Move state, priority, assignee, labels, cycle, milestone, due date
- Edit descriptions with stale-guard protection
- Comment, link relations, archive noise

## Day loop

```text
1. Discover queue  → mine / list / search / show
2. Point write     → set / comment / relation / link
3. Guarded body    → pull → edit cache → push or publish-cache
4. Close out       → archive (soft) when appropriate
```

## 1. Discover queue

```sh
lebop mine
lebop list --assignee me --state-type started
lebop list --project "Billing API v2" --label type:feature
lebop search --query "metering"
lebop show TEAM-101
lebop show TEAM-101 --content-file ./issue.md
```

- List/mine are **slim** by default; `--fields full` only when needed.
- Follow `next[]` / `next_cursor` / `has_more`.
- **Do not `pull` for research-only** — `show` is enough to read.

## 2. Point mutations

```sh
lebop set state TEAM-101 "In Progress"
lebop set priority TEAM-101 urgent
lebop set estimate TEAM-101 3
lebop set assignee TEAM-101 @me
lebop set project TEAM-101 "Billing API v2"     # or null
lebop set milestone TEAM-101 "Launch"           # or null
lebop set cycle TEAM-101 "Cycle 12"             # or null
lebop set due-date TEAM-101 2026-09-01          # or null
lebop set labels TEAM-101 +urgent -area:backend
lebop set parent TEAM-101 TEAM-100              # or null
lebop set links TEAM-101 +blocks:TEAM-102 +related:TEAM-103
# Removals: -blocks:TEAM-102 require --yes
lebop set description TEAM-101 --description-file ./body.md
lebop comment add TEAM-101 --body "LGTM"
```

CLI link kinds are **hyphenated** (`blocked-by`, `duplicated-by`). Prefer point path for single fields; use cache path for concurrent body protection.

## 3. Guarded body / bulk edit

```sh
lebop pull TEAM-101
# or ranges TEAM-1..TEAM-5, lists, --project "Name"
# edit ~/.lebop/cache/<workspace-slug>/<repo-hash>/issues/TEAM-101/description.md
# metadata.yaml — do NOT edit _server:
lebop status
lebop push --dry-run
lebop push
# reviewed:
lebop publish review --cache TEAM-101
lebop publish apply <review_id>
```

| Rule | Detail |
|------|--------|
| Overwrite dirty cache | `pull --refresh --yes` only when intentional |
| Export without cache | `pull … --to DIR` |
| Stale remote | re-pull/reconcile or deliberate `--force --yes` |
| Lint | runs on push; `--strict` blocks on warnings |

## 4. Create / archive (ad-hoc)

```sh
lebop new --title "…" --project "…" --state Backlog --priority high
lebop archive TEAM-101 TEAM-102 --yes
# unarchive reverses issue soft-archive
```

Prefer plan directories when creating a whole project graph (program workflow), not repeated `new` for a designed graph. Project/document/initiative cleanup is **out of this role** — use program CLI: `project|document|initiative soft-delete … --yes` (not bare `delete`).

## Renderer quirks (when editing markdown)

- Blank line before `---` (setext H2). L006.
- Table cells must not start with `N.` / `-` / `*`. L001/L002.
- `lebop lint [paths…] [--fix] [--strict]`

## Collab note

Point field updates (`set` / `update_issue`) are **last-write-wins** (no CAS). For contested multi-line descriptions use pull→push or publish-cache.

## Anti-patterns

- Pulling an entire project to change one state field (`set` is enough)
- Plan apply for a one-line title tweak
- Editing `_server:` or treating `context/` research as cache
- Rewriting from truncated bodies
- Force-push without reading remote drift

## Done checklist

- [ ] Correct issue(s) identified (`show`/`list` evidence)
- [ ] Point writes when sufficient; cache path for guarded bodies
- [ ] Stale-guard respected (or force justified)
- [ ] Outcome summarized with identifiers (`TEAM-###`)
