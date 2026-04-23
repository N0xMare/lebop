# leebop plan — spec

**Status:** design, pre-implementation (Phase 4b)
**Command:** `leebop plan {validate,apply}`
**Paired with:** `docs/spec.md` (overall architecture), `docs/implementation-plan.md` (living phase tracker)

## 1. What this is

A declarative flow: author a Linear project + its issues as plain markdown files in a directory, then run `leebop plan apply <dir>` to realize the whole graph in Linear in one pass. Re-runnable and idempotent — subsequent applies push only diffs and no-op on unchanged entries.

Motivating use case: "design an initiative in markdown with an agent, then push the whole thing to Linear." Complements (but does not replace) the per-issue `pull → edit → push` loop.

## 2. Layout

One directory per plan:

```
plans/relayer-hardening/
├── _project.md             # required; the project metadata + content body
├── 01-eth-fee-history.md   # one file per issue
├── 02-multi-rpc.md
├── 03-bench-harness.md
└── ...
```

**Filename → slug** derivation: the stem (filename minus `.md`) is the slug used for intra-plan references. `03-bench-harness.md` → slug `03-bench-harness`. Explicit `slug:` in frontmatter overrides.

**File order is not load-bearing.** Any ordering or naming scheme works; numeric prefixes are a human convention for reading order only.

## 3. File formats

### 3.1 `_project.md`

```markdown
---
name: Relayer Hardening v2
description: "tagline ≤ 255 chars"
state: backlog                      # backlog | planned | started | completed | canceled
team: UE                            # team KEY (not UUID)
linear_id: 88377408-…               # written back by leebop after first apply
---

# Project body content goes here.
Full markdown; same as what `leebop pull --project` would produce.
```

Required: `name`, `team`.
Optional: `description`, `state`, `linear_id` (written back).
Body: project's long-form content; optional.

### 3.2 Issue files (`*.md`, excluding `_project.md`)

```markdown
---
title: "Chain-aware initial gas pricing via eth_feeHistory"
state: Backlog                       # state NAME (case-insensitive)
priority: high                       # name (none|urgent|high|normal|low) or 0..4
labels:
  - type:feature
  - area:relayer
assignee: justice@unlink.xyz         # email | name | @me | null
linear_id: UE-401                    # written back by leebop after first apply

blocks:                              # outgoing; list of slugs OR UE-### identifiers
  - 02-multi-rpc
  - UE-321
blocked_by:                          # incoming blocks (this issue is blocked by...)
  - 03-bench-harness
related:
  - UE-250
duplicates:                          # WARNING: can move this issue to state "Duplicate"
  - UE-200
duplicated_by:                       # WARNING: can move those issues to state "Duplicate"
  - 04-canonical
---

# Body markdown.
This is the issue description — same renderer rules as `leebop pull`.
```

Required: `title`.
Optional: `state`, `priority`, `labels`, `assignee`, `linear_id`, all link fields.
Body: description; optional.

Link type naming uses **snake_case** in YAML (`blocked_by`, `duplicated_by`) to match YAML idiom; maps 1:1 to `set links` kinds `blocked-by` / `duplicated-by`.

### 3.3 Link reference resolution

Each entry in `blocks:` / `blocked_by:` / `related:` / `duplicates:` / `duplicated_by:` is **either**:

- A **local slug** — another issue file in the same plan. Resolved to its `linear_id` at apply time (post-create).
- A **Linear identifier** matching `^[A-Z]+-\d+$` — an external issue outside the plan. Resolved to its UUID via a lookup.

**Heuristic:** if the entry matches the `TEAM-NN` regex, it's external; otherwise it's a local slug. Validator warns if a slug happens to match the identifier regex (e.g. filename `UE-fix.md`).

## 4. Apply semantics

`leebop plan apply <dir>` runs this sequence:

### 4.1 Parse + validate
Every file is parsed (YAML frontmatter + markdown body). Validation fails fast on:
- Missing `_project.md`
- Required fields missing (`title` on an issue, `name` + `team` on project)
- Duplicate slugs
- Link references to unknown slugs or malformed identifiers
- YAML parse errors

And warns (non-fatal) on:
- Cycles in the `blocks` / `blocked_by` graph
- `duplicates:` / `duplicated_by:` entries (Linear side-effect: moves involved issues to state `Duplicate` with type `canceled`)
- Slugs matching the `TEAM-NN` regex
- Lint warnings on any body (same rules as `leebop lint`)

### 4.2 Project upsert
- If `_project.md` has no `linear_id`: call `projectCreate`, write the returned UUID back to `_project.md`.
- If `linear_id` present: diff against live remote; call `projectUpdate` only if differences.

### 4.3 Issue upsert (per-file, in file-read order)
For each issue file:
- If no `linear_id`: call `issueCreate` with the resolved fields. Write returned identifier (e.g. `UE-402`) back to the frontmatter.
- If `linear_id` present:
  - Fetch current remote state
  - Diff frontmatter/body against live fields (same logic as `push`)
  - Call `issueUpdate` only if differences
  - CAS check via `updatedAt` — refuse (and report) if remote moved since any prior state we know of. `--force` skips CAS.

If any issue's lint produces warnings and `--strict` is set, that issue is skipped with status `lint-blocked`. Without `--strict`, warnings print and the push proceeds.

### 4.4 Link rewriting (slug → identifier)
After all issues have `linear_id`s populated, leebop rewrites the plan files:
- Each entry in `blocks:` / `blocked_by:` / `related:` / `duplicates:` / `duplicated_by:` is translated from slug → `UE-XXX` if it was a slug.
- External identifiers are left unchanged.

After this step, subsequent applies see only real identifiers — slugs become irrelevant.

### 4.5 Relation application
For each link entry, call `issueRelationCreate` with:
- `type` = `blocks` / `related` / `duplicate` (mapping: `blocked_by` → type `blocks` with issueId/relatedIssueId reversed; same for `duplicated_by`)
- `issueId` + `relatedIssueId` derived from the link field and its direction

`issueRelationCreate` is server-side idempotent at the `(issueId, relatedIssueId, type)` tuple, so re-runs are safe. **But:** Linear enforces at most one relation per issue pair — adding `related:X` replaces any pre-existing `blocks:X` or reverse. The plan apply order (file-by-file) means the last `+` token against a given pair wins. The validator's cycle check flags obvious conflicts; it does not currently enforce pair-uniqueness (future enhancement).

### 4.6 Result reporting
Prints per-entity status:
- `✓ created` / `✓ updated` / `· unchanged` / `✗ error` / `! stale` / `✗ lint-blocked`
- Summary line: `N created · M updated · K unchanged · L errors`
- `--json` emits a structured `{schema_version: 1, project: {...}, issues: [...], relations: [...]}` record

Exit 1 if any entity errored, was stale, or was lint-blocked. Partial failures do NOT roll back — re-running picks up where the prior apply left off (linear_ids already written).

## 5. CLI surface

```
leebop plan validate <dir> [--team KEY] [--json]
leebop plan apply    <dir> [--dry-run] [--strict] [--team KEY] [--json]
leebop plan diff     <dir> [--team KEY] [--json]
leebop plan pull     <dir> [--force] [--include-new] [--team KEY] [--json]
```

**`validate`** — parse + semantic checks (hits Linear for team metadata so it can verify label/state/assignee resolution). No Linear writes. Exit 1 on any validation error.

**`apply`** — full realization.
- `--dry-run`: print all mutations without executing. `linear_id` writeback is also suppressed.
- `--strict`: block any issue whose body produces lint warnings.
- `--team`: override team (default from project's `team:` field).

**`diff`** — show drift between plan files and live Linear.
- Per-entity field table + unified patch for body/content.
- Per-issue relation drift (links in plan but missing on remote; links on remote but missing from plan).
- Flags remote-only issues that exist in the project but aren't in the plan (separate from drift — `--include-new` resolves them).
- Exit 1 if any in-plan entity has drift. Extra-remote issues do NOT cause exit 1 (they don't overwrite anything).
- `--json` emits the full diff including patches.

**`pull`** — overwrite local plan files with remote state.
- Refuses if any in-plan entity has drift, unless `--force`.
- `--include-new` also imports issues that exist on the remote project but aren't in the plan. Imported file is named from a title-derived slug (collision-safe against existing slugs).
- Preserves `linear_id`, `team`, and the user's `slug:` override; replaces all other frontmatter fields + the body with the remote version.
- Rewrites link fields (`blocks`, `blocked_by`, `related`, `duplicates`, `duplicated_by`) to match the remote's current relation graph. The pull makes implicit inverse edges explicit — both sides of a relation get the corresponding entry in their file.

Future (not in v1):
- `leebop plan archive <dir>` — mass-archive a plan's issues + project

## 6. Idempotency + re-apply semantics

A plan can be applied repeatedly. Guarantees:

- **Create exactly once per issue.** Once `linear_id` is written back, subsequent applies update instead of create.
- **Updates are diffed field-by-field.** No-op if local matches remote.
- **Relations are idempotent by tuple.** Linear's server deduplicates on `(issueId, relatedIssueId, type)`.
- **Slug references are resolved once then rewritten.** After first successful apply, files contain only `UE-XXX` references.

## 7. What's NOT in scope (v1)

- Multiple projects per plan directory (one project per dir)
- Issue archiving via plan (delete-a-file behavior is **warn-and-ignore** — the remote issue stays; use `leebop archive` for explicit disposal)
- Comment seeding via plan
- Custom fields, cycles (Linear's iteration concept), attachments — escape via `leebop raw` as needed
- Moving issues between projects via plan
- Enforcing one-relation-per-pair across the whole graph at validate time (currently relies on Linear's server behaviour + last-write-wins ordering)

## 8. Relationship to existing leebop concepts

| Concept | Plan apply shares? |
|---|---|
| `~/.leebop/cache/` | **No.** Plan files live wherever the user puts them; they don't participate in `leebop status` / `leebop push`. |
| `_server:` snapshot | **No.** Drift detection uses live remote fetch, not a cached snapshot. |
| CAS via `updatedAt` | **Yes.** Same mechanism on per-issue update. |
| Linter (`leebop lint`) | **Yes.** Run on each body; `--strict` gates. |
| `leebop new` + `set links` | **Yes, internally.** Plan apply is a compose of `issueCreate` + `issueRelationCreate` calls; shares the same GraphQL plumbing via `src/lib/relations.ts` and the mutation helpers. |

**Design principle:** plan is for **initial authoring**; cache + push is for **ongoing editing**. After first apply, users can either (a) stay in the plan directory and re-apply, or (b) `leebop pull UE-XXX` into the cache and edit there. Both paths work; mixing them in a single session is supported but the cache does not auto-sync with plan files (see out-of-scope #5).

## 9. Example

`plans/sandbox-demo/`:

```
plans/sandbox-demo/
├── _project.md
├── 01-foundation.md
├── 02-consumer.md
└── 03-migration.md
```

`_project.md`:
```markdown
---
name: "TEST plan: sandbox demo"
description: "Plan-apply live-verify target. Safe to archive."
state: backlog
team: UE
---
# Sandbox demo

Generated by `leebop plan apply` for regression testing.
```

`01-foundation.md`:
```markdown
---
title: "Set up the foundation"
state: Backlog
priority: high
labels: [type:test]
blocks:
  - 02-consumer
related:
  - UE-359
---

Foundation work.
```

`02-consumer.md`:
```markdown
---
title: "Consumer depends on foundation"
state: Backlog
priority: normal
labels: [type:test]
blocked_by:
  - 01-foundation
---

Downstream consumer of the foundation.
```

After `leebop plan apply plans/sandbox-demo/`, each file's frontmatter contains a `linear_id:` and the slug-based link entries have been rewritten to `UE-XXX`.

## 10. Open questions (defer until concrete)

- **Relation-replacement awareness at apply time.** Currently if a plan declares `blocks: [X]` and `related: [X]` on the same issue, the second write silently replaces the first (Linear's one-relation-per-pair rule). Validate could catch this class; currently it doesn't. Track if this bites.
- **Issue deletion via plan.** Explicit opt-in verb (`leebop plan archive`) feels right if/when wanted.
- **Body lint autofix integration.** Should `plan apply --fix` run lint `--fix` on bodies before push? Possibly, but introduces a file-mutation surprise. Defer.

---

**See also:** `docs/spec.md` §8 for the full leebop verb surface; `docs/implementation-plan.md` for current phase status.
