---
name: lebop-cli-program
description: "CLI program role for Linear: research initiatives/projects, scope work, author project+issue plans, attach initiatives, reviewed publish, and write project/initiative status updates. Shell + lebop CLI only. Compose path — no _initiative.md. Personal API key only."
---

# lebop-cli-program

**One role (CLI):** research program context, scope work, realize **project + issue** graphs, link under initiatives, publish status updates.

This skill is self-contained. Use only the **lebop CLI** (shell). Machine/TOON default. If `lebop` is missing from PATH, stop and report. Do not use MCP tool names here.

## Kernel (always)

- Destructive/overwrite: CLI **`--yes`** where required.
- Stale-guarded: plan apply / publish refuse if remote moved; refresh or deliberate `--force --yes` (skips **all** freshness preflight).
- Multi-ws: same `--workspace` / `LEBOP_WORKSPACE` / auth default for every step.
- Large bodies: default **64 KiB** on getters; prefer `--content-file` before editing truncated text; never rewrite from truncated bodies.
- Shared plans: **one first-applier** until `linear_id` writeback is in git (else duplicate issues).

## When to use

- Scope an initiative / multi-project epic
- Plan and ship a project graph into Linear
- Write on-track / at-risk updates for project or initiative
- Greenfield program work (not single-issue queue grinding)

## Atomic loop

```text
1. Research   → explore/fetch
2. Scope      → projects, issues, parents, relations, labels
3. Author     → plan dir(s): _project.md + issue *.md
4. Realize    → validate → lint → publish review --plan → publish apply
5. Attach     → initiative create (anytime before add-project) → add-project
6. Narrate    → initiative-update / project-update (--health + body)
7. Collab     → commit linear_id writeback before teammates apply
```

No single declarative apply for initiative + N projects + all issues (**compose**).

## 1. Research

```sh
lebop workspace explore / --query "…"
lebop workspace explore /initiatives --query "…"
lebop workspace fetch /initiatives/<id-or-name> --depth shallow
lebop workspace fetch /projects/<uuid>
```

- Default fetch depth **shallow**; `--depth full` only when nested issue dossiers are required.
- Research under `~/.lebop/context/…` — **not** cache; do not `pull` for research-only.
- Follow `next_cursor` / `continuations` as needed. `_meta.linear_api` = budget telemetry.
- `--team` narrows project/issue/cycle only.

## 2. Scope (before writing markdown)

| Decision | Notes |
|----------|--------|
| Initiative | New vs existing; name/status/owner/target-date |
| Projects | One plan dir per Linear project; team **key**; state |
| Issues | Titles, `parent:` slug, estimates, labels, priority |
| Relations | YAML snake_case lists; one Linear record per issue pair |
| Updates | Whether project-update / initiative-update is in scope |

Prefer fewer well-linked issues. Reuse existing entities when research shows them.

## 3. Author plan dirs

```text
plans/<project-slug>/
  _project.md
  epic.md
  design.md
```

**`_project.md`:**

```markdown
---
name: Billing API v2
description: "tagline ≤ 255 chars"
team: ENG
state: backlog
---

# Project body (optional)
```

Required: `name`, `team` (KEY not UUID). Optional: `description`, `icon`, `state`, `linear_id` (writeback).

**Issue file:**

```markdown
---
title: "Design usage metering API"
state: Backlog
priority: high
estimate: 3
labels:
  - type:feature
parent: epic
blocks:
  - impl
blocked_by:
  - web-ui
---

# Issue body (optional)
```

Required: `title`. Filename stem = slug (`design.md` → `design`); optional `slug:` override.  
Relation keys: `blocks`, `blocked_by`, `related`, `duplicates`, `duplicated_by` (snake_case). Duplicates kinds may cancel issues as Duplicate.  
Maps to **one project + issues** — not an Initiative.

```sh
lebop plan validate plans/<project-slug>
lebop plan lint plans/<project-slug> --fix
```

Renderer: blank line before `---`; table cells must not start with `N.` / `-` / `*`.

## 4. Realize (prefer reviewed publish)

```sh
lebop publish review --plan plans/<project-slug>
lebop publish apply <review_id>
# or: lebop plan apply plans/<project-slug> [--dry-run]
```

- Apply writes `linear_id` back; re-apply idempotent when in sync.
- Stale/missing: `plan pull` or deliberate `--force --yes` after review.
- Parents before children; slug links rewrite to `TEAM-###` after create.

## 5. Initiative attach

```sh
lebop initiative create "Program name" [--description …] [--status …] [--owner-id …]
lebop initiative add-project <initiative> <project> [--sort-order N]
# reverse: lebop initiative remove-project … --yes
```

Create initiative anytime before `add-project`. IDs or exact names resolve.

## 6. Status updates

```sh
lebop project-update create <project> --body "…" --health onTrack|atRisk|offTrack
lebop initiative-update create <initiative> --body "…" --health onTrack|atRisk|offTrack
# cleanup: project-update|initiative-update soft-delete <uuid> --yes
```

Prefer `--body-file` for multi-line text. Reflect researched blockers/risk. Lint complex tables.

## Soft-delete (PM cleanup — not issue archive)

| Target | CLI |
|--------|-----|
| Project | `lebop project soft-delete <id> --yes` |
| Document | `lebop document soft-delete <id> --yes` |
| Initiative | `lebop initiative soft-delete <id-or-name> --yes` |
| Status updates | `project-update` / `initiative-update` `soft-delete <uuid> --yes` |

Sets Linear `archived_at`. **Not** restored by issue-style `unarchive`. Do not invent bare `project delete` / `document delete` / `initiative delete` — hard cutover, no aliases.

## Collaboration

| Rule | Why |
|------|-----|
| One first-applier per plan dir until writeback in git | Parallel apply without shared `linear_id` → duplicates |
| Commit writeback immediately after apply | Teammates need ids before re-apply |
| Same workspace pin for all steps | Path isolation / `workspace_required` |

Duplicates already exist: archive extra **issues** with `lebop archive <ids…> --yes`; clean duplicate **projects** with `lebop project soft-delete <project-id> --yes` (not bare `delete`); rewrite plan `linear_id`s to keepers.

## Anti-patterns

- Inventing `_initiative.md` or multi-project plan roots
- Creating a whole graph with repeated `new` (use plan)
- `pull` for research dossiers (use explore/fetch)
- Rewriting from truncated `show`/`view` output
- Skipping plan lint on markdown that Linear will render

## Done checklist

- [ ] Research consulted; scope explicit in plan files
- [ ] Each project plan validated + linted + applied (or publish-applied)
- [ ] Initiative membership correct
- [ ] Status update(s) if user asked for narrative
- [ ] Writeback committed / handed off for multi-user plans
