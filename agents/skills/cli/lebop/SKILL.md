---
name: lebop-cli
description: "Linear workspace research and writes via lebop CLI (shell). Explore/fetch, issues, projects, initiatives, plan apply, pull-edit-push, reviewed publish, GraphQL escape hatch. Use when lebop is on PATH. Personal API key only; not an app-agent host. CLI medium only."
---

# lebop-cli

Complete guide for **lebop CLI** (shell). Machine/TOON is the agent default.

**Identity:** personal API key (`lebop auth login`). Not an app-agent/webhook host. `agent-session list|view` is read-only research of sessions created elsewhere.

If `lebop` is missing from PATH, stop and report that. Do not invent alternate products. Do not switch to MCP tool names in this skill — this is the **CLI** medium only.

## Discover before inventing flags

| Step | Command |
|------|---------|
| Orient | `lebop` or `lebop --offline` (dense TOON home) |
| Catalog | `lebop help` / `lebop --help` |
| One command | `lebop help <cmd>` or `<cmd> --help` |

Machine/TOON is the **default** (no `--json` required). Use `--format json` or `LEBOP_MACHINE_FORMAT=json` when a host must `JSON.parse`. Envelopes include `schema_version: 2`. Follow **`next[]`** (string stubs), plus `continuations` / `has_more` / `next_cursor` where present.

## Kernel (always)

- **Issue relations default (dual-surface):** CLI `show` includes relations unless `--no-relations`; MCP `get_issue` omits them unless `include_relations: true`. Opt in on MCP when you need the graph.
- **content_file / --content-file** writes the **host filesystem** (not pure read-only). Prefer project dir or `/tmp`; never write through a symlink final path.
- **Contested multi-line bodies:** prefer pull→push / publish-cache over point `set description` / `update_issue` description (last-write-wins).
- Destructive/overwrite commands need CLI **`--yes`** where required.
- Stale-guarded: `push` / plan apply / publish refuse if remote moved. Refresh deliberately or `--force --yes` (skips **all** freshness preflight: stale + missing + invalid).
- Multi-workspace: pin `--workspace` / `LEBOP_WORKSPACE` / auth default; mismatch or unset multi-ws → wrong org or `workspace_required`.
- Large text on issue/document/project/initiative reads: default **64 KiB** UTF-8. If truncated, prefer `--content-file PATH` (**writes host FS** — use project dir or `/tmp`) before editing; never rewrite from a truncated body; `--full-content` only when full wire body is required.
- Shared plans: **one applier** until `linear_id` writeback is committed to git — parallel apply without shared ids creates **duplicate Linear issues**.
- Prefer first-class verbs over `lebop raw`. High-frequency paths densify `next[]`.

## Depth ladder (go deeper only as needed)

| Level | Use for | Typical verbs |
|-------|---------|---------------|
| **L0** | Orient, catalog | `lebop`, `help`, `teams`, `auth list` |
| **L1** | Find + read + point write | `list`/`mine`, `search`, `show`, `set`, `comment`, `new`, `archive` |
| **L2** | Research dossiers + guarded bodies + greenfield graphs | `workspace explore`→`fetch`, `pull`→`push`/`publish review`, `plan` + `publish review --plan` → `publish apply` |
| **L3** | Full PM surface + escape hatch | `initiative*`, `project*`, `document`, `milestone`, `cycle`, `label`, `view`, `custom-field`, `history`, `notifications`, `raw` |

Do not pull for research-only. Do not open L3 until L1/L2 cannot answer the goal.

## Object + verb chooser

| Goal | Verb |
|------|------|
| Workspace research | `workspace explore` → `workspace fetch` (default depth **shallow**) |
| Filter issues | `list` / `mine` (slim; `--fields full` to expand) |
| Free-text search | `search --query "…"` |
| Read one issue | `show` |
| Read project / initiative / document | domain `view` |
| Point field edit | `set <field> <id> …` / `comment add` / `relation` / `link` |
| Multi-line body / bulk edit | `pull` → edit cache → `push` or `publish review --cache` → `publish apply` |
| Create one issue | `new --title "…"` |
| Archive **issue** | `archive <id…> --yes` (soft; `unarchive` reverses) |
| Soft-delete **project / document / initiative** | `project\|document\|initiative soft-delete <id> --yes` (sets `archived_at`; **not** issue-style unarchive; not bare `delete`) |
| Soft-delete status updates | `project-update soft-delete` / `initiative-update soft-delete` `--yes` |
| Greenfield **project + issues** | `plan validate\|lint\|apply` or `publish review --plan` → `publish apply` |
| Org **initiative** | `initiative create\|view\|update\|add-project\|…` (not a plan root) |
| Status posts | `project-update` / `initiative-update` (`--health`) |
| Docs / labels / cycles / milestones | first-class domain verbs (`document soft-delete`; hard `delete` only where documented — labels/milestones/comments/…) |
| Custom views / fields | `view`, `custom-field` |
| History / inbox | `history`, `notifications` |
| Escape hatch | `raw` (mutations need documented allow/confirm flags) |

## Workflows

### Research only

```sh
lebop workspace explore /
lebop workspace explore /projects --query "Billing"
lebop workspace fetch /projects/<uuid>          # default depth shallow
lebop workspace fetch TEAM-101 --depth full     # nested only when needed
```

- Bare ids (`TEAM-101`) or paths (`/issues/TEAM-101`) work.
- `--team` narrows **only** project, issue, cycle. Initiatives/docs/milestones/agent-sessions: `--kind`, paths, limits, fetch controls.
- Explore: `next_cursor` where supported; `--limit` is page size (search: per kind).
- Fetch: `--limit` per collection / nested parent / relation direction. Omitted `include` → defaults; `--include ""` → root shell only.
- Research files under `~/.lebop/context/<workspace-slug>/<repo-hash>/` (or `--to`). **Not** editable cache.
- Optional `_meta.linear_api`: budget telemetry, not completeness.

### Point mutation (no cache stale guard)

```sh
lebop set state TEAM-101 "In Progress"
lebop set priority TEAM-101 urgent
lebop set labels TEAM-101 +urgent -area:backend
lebop set assignee TEAM-101 @me
lebop set links TEAM-101 +blocks:TEAM-102
# removals like -blocks:ID need --yes
lebop set description TEAM-101 --description-file ./body.md   # direct write
lebop comment add TEAM-101 --body "LGTM"
```

`set description` is **not** stale-guarded — use pull→push for concurrent body protection.

### Guarded body / bulk edit

```sh
lebop pull TEAM-101
# edit ~/.lebop/cache/<workspace-slug>/<repo-hash>/issues/TEAM-101/description.md
# metadata.yaml — do NOT edit _server:
lebop status
lebop push --dry-run
lebop push
# or: publish review --cache TEAM-101 → publish apply <review_id>
```

Overwrite dirty cache: `pull --refresh --yes`. Export only: `pull … --to DIR`.

### Declarative project plan (hero)

```text
plans/<name>/
  _project.md      # required: name, team (KEY)
  issue-a.md       # required: title; optional parent, relations, …
```

```sh
lebop plan validate plans/<name>
lebop plan lint plans/<name> --fix
lebop publish review --plan plans/<name>
lebop publish apply <review_id>
# or: lebop plan apply plans/<name> [--dry-run]
```

**`_project.md` required:** `name`, `team`. Optional: `description`, `icon`, `state`, `linear_id` (writeback).  
**Issue files required:** `title`. Optional: `state`, `priority`, `estimate`, `labels`, `assignee`, `parent`, `blocks` / `blocked_by` / `related` / `duplicates` / `duplicated_by` (YAML **snake_case**), `linear_id`.  
CLI `set links` uses **hyphenated** kinds (`blocked-by`). `duplicates` may cancel as Duplicate in Linear.  
One plan dir = **one Linear project + issues** — not an Initiative.

### Initiative → project(s) → issues (compose)

There is **no** `_initiative.md` plan root. Compose:

1. Research initiative/projects with explore/fetch.
2. `initiative create` when needed (anytime before attach).
3. `plan` / publish-plan **once per project** graph.
4. `initiative add-project <initiative> <project>`.
5. `initiative-update` / `project-update --health …` for narrative.

### Day-loop snapshot

```sh
lebop mine
lebop list --assignee me --state-type started
lebop show TEAM-101 --content-file ./issue.md
lebop set state TEAM-101 "In Progress"
lebop archive TEAM-101 --yes
```

### Create ad-hoc

```sh
lebop new --title "…" --project "…" --state Backlog --priority high
```

## Linear renderer quirks (lint)

- Setext H2: blank line before `---` (text above `---` becomes H2). L006.
- Table cells starting with `N.` / `-` / `*` break rows. L001/L002.
- `lebop lint [paths…] [--fix] [--strict]` — omit paths to lint cache.

## Out of product

- Team create/delete/autolinks (not first-class)
- Cycle shift-all / start-upcoming-today (use `raw` if needed which exposes linear graphql API)
- Declarative multi-project / initiative plan root (compose instead)
