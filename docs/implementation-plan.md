# leebop — implementation plan

Living document. Update as phases progress, quirks are discovered, and open questions resolve. Paired with `spec.md` (stable design).

**Status legend:** ⬜ not started · 🟡 in progress · 🟢 done · ⏸ blocked

---

## Current state

**Overall:** ⬜ not started — spec finalized, no code yet.

| Phase | Status | Notes |
|---|---|---|
| 0. Bootstrap + native auth | ⬜ | source repo scaffolded with README + docs only |
| 1. MVP — the full agentic read/write surface | ⬜ | bulk round-trip + single-shot + discovery + raw escape hatch |
| 2. Projects round-trip + issue linking | ⬜ | |
| 3. Linter + auto-fix | ⬜ | |
| 4. Polish | ⬜ | `leebop new`, slash commands, SKILL.md |

---

## Phase 0 — Bootstrap + native auth

Environment, scaffolding, and the auth layer. Auth is Phase 0 because every downstream command depends on it.

### Environment
- [ ] Confirm `bun --version` works (install from https://bun.sh if missing). Fallback: `node ≥ 20` + `tsx`.
- [ ] Confirm user can create a Linear personal API key at Settings → API (needed to test `auth login`)
- [ ] Confirm the target Linear team + workspace are accessible via that PAK (a `viewer { teams }` probe)

### Scaffolding
- [ ] `bun init` in the leebop source repo
- [ ] Add deps per `spec.md` §10.2
- [ ] Strict `tsconfig.json` — `"strict": true`, `"noUncheckedIndexedAccess": true`, `"module": "NodeNext"`
- [ ] `.gitignore`: `node_modules/`, `dist/`, `*.log`, `.env*`
- [ ] Scaffold source tree per `spec.md` §5 — `src/cli.ts`, `src/commands/*`, `src/lib/*` (stubs OK at first)
- [ ] `bin/leebop` shim + `package.json` `"bin": { "leebop": "./bin/leebop" }`
- [ ] `bun link` and verify `leebop --help` runs from any cwd
- [ ] Biome config — single command to lint + format

### Auth (native PAK)
- [ ] `src/lib/auth.ts` — PAK persistence at `~/.leebop/auth.json` (0600), load/validate/delete
- [ ] `src/commands/auth.ts` — `login` (interactive prompt + `--from-schpet` import), `logout`, `whoami [--refresh]`
- [ ] `src/lib/sdk.ts` — `LinearClient` backed by stored PAK; clean 401 → "run `leebop auth login`" message

### Acceptance
- [ ] `leebop --help` prints the subcommand list from any directory
- [ ] `leebop auth login` with a fresh PAK validates against Linear and writes `~/.leebop/auth.json` with mode 0600
- [ ] `leebop auth whoami` prints `{email, name, id}` from cache; `--refresh` re-validates and updates
- [ ] `leebop auth login --from-schpet` imports the schpet-stored token (skip/soft-fail if schpet not installed)
- [ ] `leebop auth logout` removes the file; subsequent commands emit the clean "run `leebop auth login`" error

---

## Phase 1 — MVP: full agentic read/write surface

Ship-blocker. Everything an agent needs to read/write Linear end-to-end, minus project round-trip (Phase 2) and linter (Phase 3).

### Scope

**Foundations**
- `src/lib/config.ts` — resolve cwd → git root → repo config → team
- `src/lib/cache.ts` — atomic read/write for `description.md` + `metadata.yaml` (+ comments)
- `src/lib/diff.ts` — field-level diff between local `metadata.yaml` and remote snapshot
- `src/lib/resolve.ts` — name ↔ UUID resolution for labels, states, assignees
- Team metadata cache (labels, states, members) under `~/.leebop/cache/<repo-hash>/_team/<TEAM>.yaml`; refresh on demand / TTL

**Bulk round-trip**
- `leebop pull [IDS...|--project] [--no-comments]` — single, list, range (`TEAM-101..TEAM-109`), project; bundles comments by default
- `leebop push [IDS...] [--dry-run] [--force]` — CAS via `updatedAt`, field-level diff, only mutate changed fields
- `leebop status` — git-like modified/clean/stale summary

**Single-shot point edits**
- `leebop comment <ID> [--body TEXT | --body-file F | -]` — add comment
- `leebop set title|state|priority|assignee|labels <ID> <value>` — direct mutation with server-side CAS; `labels` uses `+foo -bar` delta syntax

**Discovery**
- `leebop list [filters...]` — issues by assignee/state/project/label/updated-since
- `leebop projects [--team KEY]` — list projects
- `leebop teams` — list teams

**Escape hatch**
- `leebop raw <query> [--variables-json FILE|-]` — GraphQL passthrough

**Cross-cutting**
- `--json` flag on all read commands (`list`, `projects`, `teams`, `status`, `pull` summary) — stable schema, versioned `{"schema_version": 1, ...}`

### Build order (strict)
1. `config.ts` + `cache.ts` + `resolve.ts` — foundations (SDK client already wired in Phase 0)
2. `leebop list` — proves SDK + filter plumbing; agent-critical entry point
3. `leebop teams` + `leebop projects` — cheap, validate team metadata cache
4. `leebop pull` (+ comments) — proves cache format works
5. `leebop status` — proves diff detection works
6. `leebop push` with `--dry-run` from day one — ship-blocker
7. `leebop comment` + `leebop set` — leverage existing mutation plumbing
8. `leebop raw` — trivial once SDK client exists; closes the completeness gap

### Acceptance criteria

**Discovery / read**
- [ ] `leebop list --assignee me --state-type started` returns current in-flight work with `--json` schema `{schema_version, issues: [{identifier, title, state, assignee, updated_at, url}]}`
- [ ] `leebop teams --json` lists the user's teams; `leebop projects --team TEAM` lists projects in that team

**Bulk round-trip**
- [ ] `leebop pull TEAM-101..TEAM-109` — 9 issue dirs written under `~/.leebop/cache/<hash>/issues/`, each with `description.md` + `metadata.yaml` + `comments/*.md`
- [ ] Edit one `description.md`; `leebop push` pushes **only** that issue's description (verify mutation payload with `--dry-run`)
- [ ] Add a label to `metadata.yaml`; `leebop push` resolves name → UUID and sends a full `labelIds` set (existing + new, respecting REPLACE semantics)
- [ ] Stale-remote case: edit via Linear UI after local pull → `leebop push` refuses with a clean conflict message suggesting `leebop pull <ID> --refresh`
- [ ] Edit 3 issues locally → `leebop status` shows 3 modified, rest clean
- [ ] `leebop push --force` bypasses CAS (tested; documented as dangerous)

**Single-shot**
- [ ] `leebop comment TEAM-101 --body "LGTM"` adds a comment and exits clean
- [ ] `leebop set state TEAM-101 "In Progress"` resolves state name → UUID and updates
- [ ] `leebop set labels TEAM-101 +urgent -area:backend` applies the delta (full set recomputed internally, `labelIds` REPLACE semantics respected)
- [ ] `leebop set description TEAM-101 ...` refuses — error points user at `pull` → edit → `push`

**Escape hatch**
- [ ] `leebop raw 'query { viewer { id email } }'` prints the JSON response

**Estimated size:** ~450 lines of source.

---

## Phase 2 — Projects round-trip + issue linking

### Scope
- Extend cache to `projects/<uuid>/` with `content.md` + `metadata.yaml`
- `leebop pull --project "Name"` / `--project-id <uuid>` — fetches project + child issues (comments already bundled in Phase 1)
- `leebop push` handles `projectUpdate` (content, description, state)
- **Issue linking:** `leebop set links <ID> blocks:TEAM-102,related:TEAM-103,duplicates:TEAM-104` — delta syntax (`+blocks:TEAM-105`, `-related:TEAM-103`); maps to Linear's `IssueRelation` mutations

### Acceptance criteria
- [ ] `leebop pull --project "Example Project"` produces project dir + all child issue dirs
- [ ] Edit project `content.md` locally; `leebop push` updates project content, does **not** touch child issues unless they're also modified
- [ ] `leebop set links TEAM-101 +blocks:TEAM-102` creates the blocks relation; re-running is idempotent (no duplicate relation)
- [ ] `leebop set links TEAM-101 -blocks:TEAM-102` removes the relation

**Estimated size:** ~120 additional lines.

---

## Phase 3 — Linter + auto-fix

### Scope
- `src/lib/quirks.ts` — universal rules (L001–L005 per `spec.md` §9.1)
- `src/lib/lint.ts` — rule runner with severity + auto-fix hooks
- Repo-scoped rules (R001–R002) loaded from `config.yaml`
- `leebop lint [PATHS...] [--fix] [--strict]`
- `leebop push` calls lint first; `--strict` push blocks on warnings

### Acceptance criteria
- [ ] Lint against a table with a cell = `1. Foo` emits `L001` warning
- [ ] `leebop lint --fix` rewrites `1. Foo` → `Row 1 — Foo` without mangling adjacent cells
- [ ] Lint against a description containing a configured `path_rewrites.from` prefix emits `R001` and applies the `to` prefix on `--fix`
- [ ] `leebop push --strict` refuses to push content with outstanding `L001` / `R001` warnings
- [ ] Table-driven fixture tests under `tests/quirks/` — one fixture per rule, expected `--fix` output

**Estimated size:** ~100 additional lines.

---

## Phase 4 — Polish (optional)

- [ ] `leebop diff <ID>` — unified diff vs live remote (with `--json` output)
- [ ] `leebop new --from <template|yaml>` — template-driven issue creation (bulk and single), reusing the cache file format
- [ ] Slash commands in `~/.claude/commands/`: `/leebop-pull`, `/leebop-push`, `/leebop-lint`
- [ ] `SKILL.md` at `~/.claude/skills/leebop/SKILL.md`
- [ ] Short-alias CLIs (`lp pull` or `leebop-pull` symlinks) if ergonomics demand
- [ ] Git pre-commit hook on leebop's own repo — self-lint fixtures

---

## Test strategy

### Unit
Vitest against pure functions: `config` resolution, `diff`, name → UUID resolution, YAML parsing/serialization preserving comments.

### Integration
Real Linear API via a dedicated sentinel issue + sentinel project in the target team. Don't mock the SDK — the whole point is catching real Linear behavior (including renderer quirks as they emerge).

- Gate integration tests on `LINEAR_TEST_TOKEN` env var — `test.skipIf(!process.env.LINEAR_TEST_TOKEN)`
- Sentinel config: a `.leebop-test-target.yaml` at repo root naming the test team + sentinel issue ID. Re-runnable; tests must reset the sentinel's fields at teardown.

### Linter
Table-driven. Each rule in `quirks.ts` has a fixture file that triggers it and an expected `--fix` output. `vitest.each` iterates.

### Real-world stress test
End-to-end validation against a real multi-issue project (≥1 project + several issues with rich markdown tables + cross-references). Pull → edit → push round-trip must produce no diff when the edit is a no-op.

---

## Progress log

Append dated entries as work happens. Keep entries terse — link commits / PRs.

- **2026-04-22** — spec + implementation plan drafted. No code.
- **2026-04-22** — revised scope: leebop owns the full agentic Linear surface (auth, discovery, bulk round-trip, single-shot edit, GraphQL escape hatch). Native PAK auth replaces shelling out to `@schpet/linear-cli`. Phase 1 estimate bumped from ~200 → ~450 lines. Comment-read moved from Phase 2 → Phase 1 (bundled with `pull`). Issue linking added to Phase 2.

---

## Discovered quirks (living list)

Rules that emerge during implementation beyond `spec.md` §6.2. Add here first, promote to spec once verified.

_(none yet)_

---

## Open questions — running log

Mirror of `spec.md` §12 plus anything that surfaces during build. Answer inline as resolved.

| # | Question | Lean | Resolved? |
|---|---|---|---|
| 1 | Name-resolution on ambiguous label/state prefix | exact match, fail with candidate list | ⬜ |
| 2 | Cache location when not in a git repo | `~/.leebop/cache/_global/` + `default_team` | ⬜ |
| 3 | Batch size for `updatedAt` CAS checks | 10/query; benchmark later | ⬜ |
| 4 | `--project NAME` pulls issues by default? | yes, with `--no-issues` opt-out | ⬜ |
| 5 | App-actor OAuth timing | defer until audit-trail noise observed | ⬜ |
| 6 | `leebop set` field-set stability | start with title/state/priority/assignee/labels; links in Phase 2; description/content deliberately excluded | ⬜ |

---

## Handoff / resumption checklist

If an agent or the builder picks this up after a break, in order:

1. Read `spec.md` end-to-end.
2. Read this file's **Current state** and most recent entries in **Progress log**.
3. Check **Discovered quirks** — these are behaviors already paid for once; don't rediscover.
4. Run `leebop --help` to see what's already wired up.
5. Pick the first ⬜ checkbox in the current phase; resume there.
6. On any new quirk: append to **Discovered quirks** before fixing, so the knowledge survives the fix.
