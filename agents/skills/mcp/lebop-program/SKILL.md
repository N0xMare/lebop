---
name: lebop-mcp-program
description: "MCP program role for Linear: research initiatives/projects via tools, scope work, author project+issue plans, attach initiatives, reviewed publish, status updates. lebop MCP tools only (prefer full profile). Compose path — no _initiative.md. Personal API key only."
---

# lebop-mcp-program

**One role (MCP):** research program context, scope work, realize **project + issue** graphs, attach initiatives, publish status updates — all via **lebop MCP tools**.

Self-contained. Tool text is **compact JSON**. Do not use CLI shell commands in this skill. If program tools (initiatives, plan_*, updates) are missing, the host is likely on **core** profile — request **full** (`lebop mcp --profile full`) or stop and report.

## Kernel (always)

- Destructive/overwrite: **`confirm: true`** when required by schema.
- Stale-guarded publish/apply paths: refresh or intentional force (skips **all** freshness preflight).
- Multi-ws: pass **`workspace`** per call; prefer host `LEBOP_WORKSPACE`.
- Large bodies: **64 KiB** default; use `content_file` before editing truncated text.
- Shared plans: **one first-applier** until `linear_id` writeback is in git.
- Follow **`next_call`** on review envelopes for structured apply when present.

## When to use

- Scope an initiative / multi-project epic through tools
- Validate/lint/apply or review-publish plan directories
- Attach projects to initiatives and post health updates
- Greenfield program work (not single-issue queue grinding)

## Atomic loop

```text
1. Research   → explore_linear_workspace → fetch_linear_workspace
2. Scope      → projects, issues, parents, relations, labels
3. Author     → plan dir(s) on host FS: _project.md + issue *.md
4. Realize    → plan_validate → plan_lint → review_linear_changes (plan)
                → publish_linear_changes (or plan_apply when review unnecessary)
5. Attach     → create_initiative (anytime before add) → initiative_add_project
6. Narrate    → create_initiative_update / create_project_update (health + body)
7. Collab     → commit linear_id writeback before teammates re-apply
```

**Compose only** — no single multi-project initiative plan root.

## 1. Research

- `explore_linear_workspace` with query/path/kind as needed (initiatives, projects).
- `fetch_linear_workspace` on initiative/project targets; depth default **shallow**.
- Research materializes under context (or `to`) — **not** issue cache; do not `pull_issues` for research-only.
- Follow continuations/cursors; treat `_meta.linear_api` as budget telemetry.
- `team` arg narrows project/issue/cycle only.

## 2. Scope

| Decision | Notes |
|----------|--------|
| Initiative | New vs existing |
| Projects | One plan dir per project; team KEY |
| Issues | titles, parent slugs, estimates, labels |
| Relations | YAML snake_case; one pair per Linear record |
| Updates | initiative/project update posts in scope? |

Prefer fewer well-linked issues. Reuse existing entities from research.

## 3. Author plan dirs (host filesystem)

```text
plans/<project-slug>/
  _project.md      # name + team required
  epic.md
  design.md
```

**`_project.md` required fields:** `name`, `team` (KEY). Optional: `description`, `icon`, `state`, `linear_id`.  
**Issue files required:** `title`. Optional: `state`, `priority`, `estimate`, `labels`, `assignee`, `parent`, `blocks` / `blocked_by` / `related` / `duplicates` / `duplicated_by`, `linear_id`.  
Filename stem = slug. One plan = **one project + issues**, not an Initiative.

Renderer: blank line before `---`; no list-marker starts in table cells.

## 4. Realize

Typical tool sequence (names as registered; confirm args from schemas):

1. `plan_validate` on plan directory
2. `plan_lint` (fix/strict as schema allows)
3. `review_linear_changes` with plan target → capture `review_id` / `next_call`
4. `publish_linear_changes` with that review

Alternatively `plan_apply` when an explicit review step is unnecessary.  
Apply writes `linear_id` into plan files; re-apply is idempotent when in sync.

**Drift / stale recovery:** `plan_diff` to inspect local-vs-remote; `plan_pull` (with confirm/force only as schema requires) to refresh local plan snapshots before re-validate/re-review. Force-style apply requires the schema’s confirm flag as well — do not force blindly.

## 5. Initiative attach (full profile)

- `create_initiative` (or use existing via list/get)
- `initiative_add_project` for each realized project
- Reverse: `initiative_remove_project` with confirm

Create initiative anytime before add-project.

## 6. Status updates (full profile)

- `create_project_update` / `create_initiative_update` with body + health (`onTrack` | `atRisk` | `offTrack` as schema allows)
- Prefer file-backed body args when available for multi-line text
- List/update as needed; cleanup with exact tools below

Bodies should reflect researched risk and progress.

## Soft-delete (PM cleanup — full profile; not issue archive)

| Target | Tool (`confirm: true`) |
|--------|------------------------|
| Project | `soft_delete_project` |
| Document | `soft_delete_document` |
| Initiative | `soft_delete_initiative` |
| Project status update | `soft_delete_project_update` |
| Initiative status update | `soft_delete_initiative_update` |

Sets Linear `archived_at`. **Not** restored by issue-style unarchive. Do **not** invent `delete_project` / `delete_document` / `delete_initiative` / `delete_*_update` — hard cutover, no aliases. Issue close-out is `archive_issue` (separate).

## Collaboration

| Rule | Why |
|------|-----|
| One first-applier until writeback in git | Duplicate Linear issues otherwise |
| Commit writeback after apply | Teammates need shared `linear_id`s |
| Consistent `workspace` | Avoid wrong org / path isolation bugs |
| Duplicate projects after parallel apply | `soft_delete_project` with `confirm: true` on extras; keep issue keepers via `archive_issue` |

## Anti-patterns

- Inventing `_initiative.md` or multi-project plan roots
- Building a designed graph only with repeated `create_issue` (use plan tools)
- `pull_issues` for research dossiers
- Rewriting from truncated `get_*` bodies
- Staying on **core** profile when initiative/plan tools are required

## Done checklist

- [ ] Research consulted; scope explicit in plan files
- [ ] Each project plan validated + linted + applied/published
- [ ] Initiative membership correct
- [ ] Status update(s) if requested
- [ ] Writeback committed / handed off for multi-user plans
