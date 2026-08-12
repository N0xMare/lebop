---
name: lebop-mcp
description: "Linear workspace research and writes via lebop MCP tools (no shell required). explore/fetch, issues, projects, pull, reviewed publish, comments, search, history, raw GraphQL. Use when the host has lebop MCP registered. Personal API key only; not an app-agent host. MCP medium only."
---

# lebop-mcp

Complete guide for **lebop MCP** (stdio tools). Tool text is always **compact JSON** (`schema_version: 2`).

**Identity:** personal API key (configured for the lebop process via `lebop auth login` / env). Not an app-agent/webhook host. Agent-session tools are **read-only** research of sessions created elsewhere.

If lebop MCP tools are not available in the host, stop and report that. Do not invent HTTP clients or CLI shell commands in this skill — this is the **MCP** medium only.

## Profiles

| Profile | Tools | When |
|---------|-------|------|
| **core** (default) | **17** | Day-to-day research + common issue writes |
| **full** | **104** | Initiatives, plan tools, documents, cycles, milestones, views, custom fields, broader PM |

Host config typically: `command: lebop`, `args: ["mcp"]` or `["mcp", "--profile", "full"]`. Prefer **core** until a goal needs tools only present in full.

### Core tools (17)

`explore_linear_workspace`, `fetch_linear_workspace`, `list_issues`, `get_issue`, `create_issue`, `update_issue`, `list_projects`, `get_project`, `pull_issues`, `review_linear_changes`, `publish_linear_changes`, `list_comments`, `add_comment`, `cache_status`, `raw_graphql`, `search_linear`, `list_issue_history`

## Kernel (always)

- **Issue relations default (dual-surface):** CLI `show` includes relations unless `--no-relations`; MCP `get_issue` omits them unless `include_relations: true`. Opt in on MCP when you need the graph.
- **content_file / --content-file** writes the **host filesystem** (not pure read-only). Prefer project dir or `/tmp`; never write through a symlink final path.
- **Contested multi-line bodies:** prefer pull→push / publish-cache over point `set description` / `update_issue` description (last-write-wins).


- Destructive/overwrite tools: pass **`confirm: true`** when the schema requires it.
- Stale-guarded: publish/push-equivalent paths refuse if remote moved; refresh deliberately or force modes that skip **all** freshness preflight (stale + missing + invalid) only when intentional.
- Multi-workspace: pass **`workspace`** (org url key) per call when multi-ws; pin `LEBOP_WORKSPACE` in host env when possible.
- Large text: primary bodies default **64 KiB** UTF-8. If truncated, prefer `content_file` (**writes host FS**) before editing; never rewrite from truncated bodies; `full_content` only when full wire body is required.
- Shared plans (full profile plan tools): **one applier** until `linear_id` writeback is committed — parallel apply without shared ids creates **duplicate issues**.
- Prefer first-class tools over `raw_graphql`. Follow envelope `next` stubs and pagination fields; publish review envelopes may include **`next_call`** `{ tool, arguments }` — prefer invoking that for apply when present.

## Depth ladder

| Level | Use for | Typical tools |
|-------|---------|---------------|
| **L0** | Orient | Host tool list; prefer core inventory |
| **L1** | Find + read + point write | `list_issues`, `search_linear`, `get_issue`, `update_issue`, `add_comment`, `create_issue` |
| **L2** | Research dossiers + guarded bodies + review/publish | `explore_linear_workspace`→`fetch_linear_workspace`, `pull_issues`, `review_linear_changes`→`publish_linear_changes` |
| **L3** | Full PM (needs **full** profile) | initiative/project/document/milestone/cycle/label/view/custom-field/plan_*, `raw_graphql` |

Do not pull for research-only. Escalate profile before inventing missing tools.

## Goal → tool chooser

| Goal | Tool(s) |
|------|---------|
| Workspace research | `explore_linear_workspace` → `fetch_linear_workspace` (default depth **shallow**) |
| Filter issues | `list_issues` |
| Search | `search_linear` |
| Read issue | `get_issue` |
| Read project | `get_project` (core) |
| Point update issue | `update_issue` |
| Comment | `add_comment` / `list_comments` |
| Create issue | `create_issue` |
| Pull to cache | `pull_issues` |
| Cache status | `cache_status` |
| Reviewed publish | `review_linear_changes` → `publish_linear_changes` (follow `next_call` when present) |
| Issue history | `list_issue_history` |
| Escape hatch | `raw_graphql` (mutations need allow/confirm flags) |
| Plan / initiatives / docs / cycles / … | **full** profile domain tools |

## Workflows

### Research only

1. `explore_linear_workspace` with path/query/kind/team/limit/cursor as needed.
2. Pick a **fetchable** target from the result.
3. `fetch_linear_workspace` with depth/include/limit/to.

- Bare issue ids accepted. `team` narrows project/issue/cycle only.
- Fetch default depth **shallow**. Empty `include: []` → root shell only.
- Research materializes under context paths (or `to`) — not the editable issue cache.
- Follow `continuations` / cursors. `_meta.linear_api` = budget telemetry.

### Point mutation

- `update_issue` with the fields needed (labels add/remove helpers where schema exposes them).
- `add_comment` for comments.
- Description updates via update path are **not** the same as cache stale-guarded body flow — use pull + review/publish when concurrency protection matters.

### Guarded body / cache publish

1. `pull_issues` (identifiers / project as schema allows).
2. Edit cache files on the host filesystem (`description.md`, `metadata.yaml`; do not edit `_server:`).
3. `review_linear_changes` (cache mode) → `publish_linear_changes` with `review_id` from review / `next_call`.

Use `cache_status` to inspect dirty/modified state when available.

### Project plan + publish (full profile)

When `plan_validate` / `plan_lint` / `plan_apply` / plan review modes are available:

- Plan dir is **project-rooted** (`_project.md` with `name` + `team` KEY; issue files with `title`; optional `parent` + snake_case relations).
- Prefer review then publish tools over blind apply when the host supports reviewed publish for plans.
- One plan = one Linear project + issues — **not** an Initiative.

### Initiative compose (full profile)

No `_initiative.md`. Compose with initiative tools + per-project plan tools + `initiative` add-project equivalents + initiative/project update tools for narrative.

### Day-loop snapshot (core)

`list_issues` / `search_linear` → `get_issue` → `update_issue` / `add_comment` → optional pull + review/publish for bodies → `archive_issue` on **full** if needed.

## Hazards (MCP wording)

- Pass `confirm: true` for destructive/overwrite tools.
- Force-style flags skip **all** freshness preflight, not only “stale.”
- One relation record per issue pair in Linear (last write wins across kinds).
- Duplicates relation kinds may cancel issues as Duplicate.
- Renderer: blank line before `---` in markdown bodies; table cells must not start with list markers.
- **Soft-delete (full profile only):** project/document/initiative cleanup tools are `soft_delete_project`, `soft_delete_document`, `soft_delete_initiative`, plus `soft_delete_project_update` / `soft_delete_initiative_update` — with `confirm: true`. Do **not** invent `delete_project` / `delete_document` / `delete_initiative` (hard cutover, no aliases). Soft-delete sets `archived_at` and is **not** restored by issue-style unarchive. Issue close-out remains `archive_issue` (reversible).

## Medium boundary

- Inbox **notifications** list is **CLI-only** (`lebop notifications`) — not registered as an MCP tool. Do not invent `list_notifications` / similar.

## Out of product

- Team create/delete/autolinks as first-class tools (unless exposed in full — prefer not inventing)
- Interactive human Linear client ergonomics
- Declarative multi-project initiative plan root (compose instead)
