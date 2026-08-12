---
name: lebop-mcp-execution
description: "MCP issue day-loop for Linear: list/search/get issue, update_issue, comments, pull_issues, review/publish cache changes, history. lebop MCP tools only (core profile usually enough). Queue execution — not program-scale planning. Personal API key only."
---

# lebop-mcp-execution

**One role (MCP):** execute on assigned or targeted issues via **lebop MCP tools** — queue, point update, guarded bodies, comments, publish-cache.

Self-contained. Tool text is **compact JSON**. Do not use CLI shell commands here. **Core** profile (17 tools) covers most of this loop; use **full** only if you need archive or broader PM tools. If tools are missing, stop and report.

## Kernel (always)

- **Issue relations default (dual-surface):** CLI `show` includes relations unless `--no-relations`; MCP `get_issue` omits them unless `include_relations: true`. Opt in on MCP when you need the graph.
- **content_file / --content-file** writes the **host filesystem** (not pure read-only). Prefer project dir or `/tmp`; never write through a symlink final path.
- **Contested multi-line bodies:** prefer pull→push / publish-cache over point `set description` / `update_issue` description (last-write-wins).


- Destructive/overwrite: **`confirm: true`** when required.
- Stale-guarded publish paths: refresh or intentional force (skips **all** freshness preflight).
- Multi-ws: pass **`workspace`**; prefer host `LEBOP_WORKSPACE`.
- Large bodies: **64 KiB** default on `get_issue`; use `content_file` before editing; never rewrite from truncated text.
- Point `update_issue` description is not the same as cache stale-guarded flow — use pull + review/publish for concurrent body protection.
- Prefer **`next_call`** from review envelopes when applying publish.

## Core tools used in this role

`list_issues`, `search_linear`, `get_issue`, `create_issue`, `update_issue`, `list_comments`, `add_comment`, `pull_issues`, `cache_status`, `review_linear_changes`, `publish_linear_changes`, `list_issue_history`, `explore_linear_workspace`, `fetch_linear_workspace` (optional research), `raw_graphql` (last resort)

Archive and some domain tools require **full** profile.

## When to use

- Work my queue / filter my started issues
- Update state, priority, assignee, labels, project, dates via tools
- Edit descriptions with review/publish protection
- Comment and inspect history

## Day loop

```text
1. Discover queue  → list_issues / search_linear / get_issue
2. Point write     → update_issue / add_comment
3. Guarded body    → pull_issues → edit cache files → review → publish
4. Close out       → archive_issue (full) when appropriate
```

## 1. Discover queue

- `list_issues` with assignee/state/project/label filters as schema allows (slim fields by default).
- `search_linear` for free-text.
- `get_issue` for one identifier; use `content_file` for large bodies.
- Optional: `list_issue_history` for audit context.
- Optional research: explore/fetch — **not** a substitute for cache pull when editing.
- Follow pagination / `next` stubs.

Do **not** `pull_issues` solely to read.

## 2. Point mutations

- `update_issue` with identifier + fields (state, priority, estimate, assignee, project, milestone, cycle, due date, labels add/remove, parent, description, … per schema).
- `add_comment` / `list_comments`.
- **Issue relations/links** (`blocks`, `related`, …) are **not** on core: use **full** profile relation tools (`add_relation` / `delete_relation` / equivalents per host tool list) with `confirm: true` on deletes. Do not invent relation args on `update_issue` or misuse `raw_graphql` for routine links.
- Prefer point updates for single-field changes.

## 3. Guarded body / cache publish

1. `pull_issues` for the identifiers (or project pull variants on full).
2. Edit host files under the cache path from the tool result (`description.md`, `metadata.yaml`; never `_server:`).
3. `cache_status` if useful.
4. `review_linear_changes` (cache mode / ids / all-modified as schema allows).
5. `publish_linear_changes` using `review_id` or envelope **`next_call`**.

| Rule | Detail |
|------|--------|
| Overwrite dirty cache | refresh/confirm flags only when intentional |
| Stale remote | re-pull or deliberate force after review |
| Lint | may run inside review/publish paths; honor strict failures |

## 4. Create / archive

- `create_issue` for ad-hoc singles.
- Designed multi-issue graphs: use plan tools on **full** (program role), not a flood of `create_issue`.
- `archive_issue` / unarchive on **full** with `confirm: true` (issue soft-archive; reversible).
- Project/document/initiative cleanup is **out of this role** — use program tools: `soft_delete_*` (not bare `delete_*`).

## Hazards

- Force-style overwrite skips **all** freshness preflight.
- One relation per issue pair; duplicates kinds may cancel as Duplicate.
- Markdown renderer: blank line before `---`; no list markers starting table cells.
- Never invent CLI `lebop …` invocations in this medium.

## Anti-patterns

- Pulling a whole project to change one state field
- Plan apply for a one-line title tweak
- Editing `_server:` or treating research context as cache
- Rewriting from truncated `get_issue` output
- Publishing without review when the user wanted an approve step

## Done checklist

- [ ] Correct issue(s) identified (`get_issue` / list evidence)
- [ ] Point tools when sufficient; pull+review+publish for guarded bodies
- [ ] Stale-guard respected (or force justified)
- [ ] Outcome summarized with issue identifiers
