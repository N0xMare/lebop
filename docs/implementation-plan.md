# leebop — implementation plan

Living document. Update as phases progress, quirks are discovered, and open questions resolve. Paired with `spec.md` (stable design).

**Status legend:** ⬜ not started · 🟡 in progress · 🟢 done · ⏸ blocked

---

## Current state

**Overall:** ⬜ not started — spec finalized, no code yet.

| Phase | Status | Notes |
|---|---|---|
| 0. Bootstrap | ⬜ | source repo scaffolded with README + docs only |
| 1. MVP (issues round-trip) | ⬜ | |
| 2. Projects + comments-read | ⬜ | |
| 3. Linter + auto-fix | ⬜ | |
| 4. Polish | ⬜ | |

---

## Phase 0 — Bootstrap

Environment and scaffolding, no application logic.

- [ ] Confirm `linear auth whoami` works (auth is pre-existing)
- [ ] Confirm the target Linear team + workspace are accessible
- [ ] Confirm `bun --version` works (install from https://bun.sh if needed). Fallback: `node ≥ 20` + `tsx`.
- [ ] `bun init` in the leebop source repo
- [ ] Add deps per `spec.md` §10.2
- [ ] Strict `tsconfig.json` — `"strict": true`, `"noUncheckedIndexedAccess": true`, `"module": "NodeNext"`
- [ ] `.gitignore`: `node_modules/`, `dist/`, `*.log`, `.env*`
- [ ] Scaffold source tree: `src/cli.ts`, `src/commands/*`, `src/lib/*` (stubs)
- [ ] `bin/leebop` shim + `package.json` `"bin"` entry
- [ ] `bun link` and verify `leebop --help` runs from any cwd
- [ ] Create `~/.leebop/` and seed `config.yaml` from `spec.md` §7.5
- [ ] Biome config — single command to lint + format

**Acceptance:** `leebop --help` prints subcommand list from any directory.

---

## Phase 1 — MVP: issues round-trip

Ship-blocker. Issues only, no projects, no linter.

### Scope
- `src/lib/config.ts` — resolve cwd → git root → repo config → team
- `src/lib/sdk.ts` — `@linear/sdk` client with bootstrap-token auth
- `src/lib/cache.ts` — atomic read/write for `description.md` + `metadata.yaml`
- `src/lib/diff.ts` — field-level diff between local `metadata.yaml` and remote snapshot
- Team metadata cache (labels, states, members) under `~/.leebop/cache/<repo-hash>/_team/<TEAM>.yaml`
- Name ↔ UUID resolution for labels / state / assignee
- `leebop pull` — single, list, range (`TEAM-101..TEAM-109`)
- `leebop push` — with `--dry-run`, `--force`, CAS via `updatedAt`
- `leebop status`
- `--json` flag on read commands (`pull` summary, `status`) — structured output with `schema_version: 1`; retrofitting later is uglier than building in

### Build order (strict)
1. `config.ts` + `sdk.ts` + `cache.ts` — foundations
2. `leebop pull` — proves cache format works
3. `leebop status` — proves diff detection works
4. `leebop push` with `--dry-run` from day one — ship-blocker

### Acceptance criteria
- [ ] `leebop pull TEAM-101..TEAM-109` — 9 dirs written under `~/.leebop/cache/<hash>/issues/`
- [ ] Edit one `description.md`; `leebop push` pushes **only** that issue's description (verify mutation payload in `--dry-run`)
- [ ] Add a label to `metadata.yaml`; `leebop push` resolves name → UUID and sends only `labelIds` (with full existing set + new, since `labelIds` replaces)
- [ ] Stale-remote case: edit via Linear UI after local pull → `leebop push` refuses with a clean conflict message suggesting `leebop pull <ID> --refresh`
- [ ] Edit 3 issues locally → `leebop status` shows 3 modified, rest clean
- [ ] `leebop push --force` bypasses CAS (tested but documented as dangerous)

**Estimated size:** ~200 lines of source.

---

## Phase 2 — Projects + comments-read

### Scope
- Extend cache to `projects/<uuid>/`
- `leebop pull --project "Name"` and `--project-id <uuid>` — fetches project + child issues
- `leebop push` handles `projectUpdate` mutation
- Comments fetched into `issues/TEAM-XXX/comments/<N>.md` (read-only; no write path)
- Comments refresh on each `pull`

### Acceptance criteria
- [ ] `leebop pull --project "Example Project"` produces project dir + all issue dirs under it
- [ ] Edit project `content.md` locally; `leebop push` updates project content, does **not** touch child issues unless they're also modified
- [ ] Comments appear as read-only files; re-pull refreshes them without clobbering user edits to descriptions

**Estimated size:** ~80 additional lines.

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
| 5 | Comment write-path in v2 or defer? | defer to v4 | ⬜ |
| 6 | App-actor OAuth timing | defer until audit-trail noise observed | ⬜ |

---

## Handoff / resumption checklist

If an agent or the builder picks this up after a break, in order:

1. Read `spec.md` end-to-end.
2. Read this file's **Current state** and most recent entries in **Progress log**.
3. Check **Discovered quirks** — these are behaviors already paid for once; don't rediscover.
4. Run `leebop --help` to see what's already wired up.
5. Pick the first ⬜ checkbox in the current phase; resume there.
6. On any new quirk: append to **Discovered quirks** before fixing, so the knowledge survives the fix.
