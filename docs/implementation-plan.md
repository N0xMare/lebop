# leebop — implementation plan

Living document. Update as phases progress, quirks emerge, questions resolve. Paired with `spec.md` (stable design).

**Status legend:** ⬜ not started · 🟡 in progress · 🟢 done · ⏸ blocked

---

## TL;DR — where we are

- **Phase 0–2.5:** 🟢 shipped and verified (see table).
- **Phase 2c (project push live-verify):** 🟢 shipped. Verified against `leebop sandbox` project. Latent bug found and fixed: `push.ts` was writing `plan.{description,content}` back to cache but computing `_server.{description,description_hash,content_hash}` from the server response — Linear's markdown re-render made those diverge permanently, leaving `status` stuck showing "modified" until `--refresh`. Fix: write `updated.description` / `updated.content` from the mutation response (so on-disk matches server-normalized form).
- **Next concrete step:** **Phase 3** (linter + auto-fix). Specific rules to encode first: (a) warning when `text\n---` becomes an H2 setext heading on push — empirically observed in sandbox regression; (b) the L001–L005 rule catalog from spec §9.1.

If you're a new agent reading this, jump to **§ Resumption checklist** below.

---

## Current state

| Phase | Status | What's in / what's out |
|---|---|---|
| 0. Bootstrap + native auth | 🟢 | scaffolding, CLI dispatcher, native PAK auth (`leebop auth login/logout/whoami`) |
| 1. MVP — agentic read/write surface | 🟢 | all verbs implemented and verified end-to-end against sentinel UE-351 + throwaway UE-352 (create/archive via `raw`). |
| 2. Issue linking (`set links`) + relations in `show` | 🟢 | `set links` shipped with 5-kind directional surface; `show` folds `relations + inverseRelations`. Live-verified via UE-355/UE-356 pair. |
| 2.5 Issue lifecycle verbs (`new`, `archive`) | 🟢 | promoted from Phase 4/raw based on usage signal. Both verified live. |
| 2c. Project push live-verify | 🟢 | verified against `leebop sandbox` project (UUID `88377408-3d52-49f8-87c3-0d0f550cc9df`); latent post-push cache-hash-drift bug discovered and fixed. |
| 3. Linter + auto-fix | ⬜ | — |
| 4. Polish | ⬜ | slash commands, SKILL.md, git pre-commit, `leebop diff`. |

Verified install / environment state on the development machine (as of last session):
- **Bun 1.3.13** on macOS (darwin 24.6.0, arm64)
- **Symlink:** `/opt/homebrew/bin/leebop → /Users/cmace/.bun/bin/leebop` exists and is on the PATH inherited by Claude Code subagents.
- **Auth:** `~/.leebop/auth.json` present (token was imported via `--from-schpet`; viewer = `justice@unlink.xyz`, team `UE`, workspace `unlink-xyz`).
- **Config:** `~/.leebop/config.yaml` seeded with `default_team: UE` and workspace URL prefix.
- **Cache:** `~/.leebop/cache/5102b4186605/` (repo hash for `/Users/cmace/dev/unlink/leebop`) — contains pulled fixtures for `UE-321..UE-329` and project `Relay Worker Refactor`.

---

## Immediate next steps (in order)

1. **Phase 3 — linter + auto-fix.** Rule catalog per spec §9.1 (L001–L005) plus a new L006 seeded by sandbox regression: `text\n---` silently becomes `## text` (setext H2) on push. Integrates with `leebop push` (`--strict` blocks on warnings).

**Mutation sandbox**: all live-test mutations now run inside the persistent **`leebop sandbox`** project (UUID `88377408-3d52-49f8-87c3-0d0f550cc9df`). Sentinel issues: **UE-359** (issue mutation) and **UE-360** (links partner). Both held at state=Backlog (not Triage — Triage bloats the global cross-project view). See `reference_leebop_sandbox.md` in auto-memory for baseline/reset instructions.

---

## Preconditions for any development

Before writing any code or running any command:

1. **Shell PATH:** confirm `which leebop` returns `/opt/homebrew/bin/leebop` (or equivalent). If it doesn't resolve, run:
   ```sh
   ln -sf "$HOME/.bun/bin/leebop" /opt/homebrew/bin/leebop
   ```
   This symlink is **load-bearing for subagent discoverability**. Without it, Claude Code subagents silently fall back to `@schpet/linear-cli` because `~/.bun/bin` isn't on their inherited PATH. See the 2026-04-22 progress-log entry "Agent-UX smoke test" for the failure mode.
2. **Auth:** confirm `leebop auth whoami` prints a viewer. If not, `leebop auth login [--from-schpet]`.
3. **Bun version:** `bun --version` ≥ 1.1.
4. **Dev flow:** from repo root, `bun install`, then `bunx tsc --noEmit` (typecheck) and `bunx biome check src/` (lint) are the two green gates before any commit. `bunx biome check --write src/` to auto-fix.

---

## Source map

Where each concern lives. Keep this current when adding files.

```
src/
├── cli.ts                    # commander dispatcher; registers all subcommands
├── commands/
│   ├── auth.ts               # login / logout / whoami
│   ├── list.ts               # issue discovery by filter
│   ├── projects.ts           # project listing
│   ├── teams.ts              # team listing
│   ├── show.ts               # read-only single-issue display + relations section
│   ├── pull.ts               # cache materialization; --to for export-mode
│   ├── push.ts               # CAS-guarded mutation; --dry-run
│   ├── status.ts             # git-like diff against _server snapshot
│   ├── diff.ts               # (stub) Phase 4
│   ├── lint.ts               # (stub) Phase 3
│   ├── comment.ts            # add a comment (direct mutation)
│   ├── set.ts                # single-shot field mutations — title/state/priority/assignee/labels/links
│   ├── new.ts                # create a new issue (Phase 2.5)
│   ├── archive.ts            # archive one or more issues (Phase 2.5)
│   └── raw.ts                # GraphQL escape hatch
└── lib/
    ├── paths.ts              # ~/.leebop/ path constants
    ├── types.ts              # AuthFile, UserConfig, RepoConfig
    ├── auth.ts               # PAK persistence + validation + linearClientFromToken
    ├── sdk.ts                # singleton LinearClient from stored PAK
    ├── config.ts             # cwd → git root → repo config → team resolution
    ├── cache.ts              # atomic read/write for issues/projects/comments/team metadata
    ├── resolve.ts            # name ↔ UUID (states/labels/assignees/priorities) + team metadata fetch
    ├── diff.ts               # field-level diff against _server snapshot
    ├── build.ts              # FetchedIssue → IssueMetadata + description (canonical build)
    ├── expand.ts             # ID range expansion (TEAM-101..TEAM-109)
    ├── pullQuery.ts          # multi-alias issue query builder + fragments (incl. relations)
    ├── pushMutations.ts      # issueUpdate/projectUpdate + batched CAS query builder
    ├── relations.ts          # issueRelationCreate/Delete + parseLinkToken (Phase 2)
    ├── argvPrep.ts           # preprocessSetArgv: auto-insert `--` for `set` negative deltas
    ├── prompt.ts             # hidden-input stdin prompt for auth login
    └── notImplemented.ts     # stub helper for unshipped verbs
```

Cache layout (under `~/.leebop/cache/<repo-hash>/`):

```
issues/<IDENTIFIER>/
├── description.md            # user-editable
├── metadata.yaml             # user-editable top-level + _server: snapshot (read-only-ish)
└── comments/<comment-uuid>.md  # YAML frontmatter + body (read-only; refreshed on pull)

projects/<project-uuid>/
├── content.md
└── metadata.yaml

_team/<TEAM-KEY>.yaml          # team metadata (labels, states, members, projects) with 1h TTL
```

`<repo-hash>` = `sha256(absolute-git-root-path).slice(0,12)`; fallback `_global` when cwd isn't in a git repo.

---

## Phase 0 — Bootstrap + native auth 🟢

Environment, scaffolding, and the auth layer.

### Environment
- [x] Bun 1.3.13 verified (upgraded from 0.8.1 during session)
- [x] Linear PAK creation verified (or `--from-schpet` import)
- [x] Target team + workspace (`UE` in `unlink-xyz`) accessible via `viewer` probe

### Scaffolding
- [x] `bun init`, deps installed (`@linear/sdk@82`, `yaml`, `commander`, `diff@9`, `chalk`; dev: `typescript`, `vitest`, `@biomejs/biome`)
- [x] Strict `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, `module: Preserve`, `moduleResolution: bundler`)
- [x] `.gitignore` (node_modules, dist, auth.json, /cache/)
- [x] Source tree + CLI dispatcher; all subcommands registered (stubs for Phase 1+ via `notImplemented()`)
- [x] `bin/leebop` shim + `package.json` `"bin"`
- [x] `bun link` + symlink into `/opt/homebrew/bin` for subagent discoverability
- [x] Biome config (`bunx biome check [--write]`)

### Auth (native PAK)
- [x] `src/lib/auth.ts` — PAK persistence at `~/.leebop/auth.json` (0600), load/validate/delete; PAK (`lin_api_`) vs OAuth-bearer discrimination via `linearClientFromToken()`
- [x] `src/commands/auth.ts` — `login` (hidden-input prompt + `--token` / `--token-file` / `--from-schpet`), `logout`, `whoami [--refresh] [--json]`
- [x] `src/lib/sdk.ts` — `LinearClient` backed by stored PAK; clean 401 → "run `leebop auth login`" message

### Acceptance
- [x] `leebop --help` prints subcommand list
- [x] `leebop auth login --from-schpet` validates + persists (mode 0600, dir 0700)
- [x] `leebop auth whoami` / `--refresh` / `--json`
- [x] `leebop auth logout` + subsequent-command clean error
- [ ] Interactive `leebop auth login` (bare prompt) — codepath exists and typechecks, **not user-verified this session**

---

## Phase 1 — MVP: full agentic read/write surface 🟡

Ship-blocker. Everything an agent needs to read/write Linear end-to-end, minus project-mutation (still Phase 2) and linter (Phase 3).

### Scope — shipped

**Foundations**
- `src/lib/config.ts` — cwd → git root → repo config → team; `<repo-hash>` = SHA-256[:12] of git root
- `src/lib/cache.ts` — atomic read/write for issues, projects, comments, team metadata; sha256 description/content hashes
- `src/lib/diff.ts` — field-level diff against `_server:` snapshot (title, description, state, priority, labels, assignee; project-level fields too)
- `src/lib/resolve.ts` — name ↔ UUID for states/labels/assignees + priority name ↔ number; team metadata fetch + 1h TTL cache
- `src/lib/build.ts` — canonical `FetchedIssue → IssueMetadata + description` mapper; used by `pull`, `push` response-refresh, and `set` cache-refresh

**Bulk round-trip**
- `leebop pull [ids...] [--project NAME|--project-id UUID] [--refresh] [--no-comments] [--to DIR] [--json]` — single / list / range / project; bundles comments; `--to DIR` for export mode (no cache write); prints target path per entity
- `leebop push [ids...] [--dry-run] [--force] [--json]` — batched CAS via multi-alias `updatedAt` query; field-level diff; only mutates changed fields; refreshes `_server` from mutation response
- `leebop status [--json]` — git-like modified/clean summary with per-field change names

**Read-only display**
- `leebop show <id> [--no-comments] [--json]` — fetch + print inline, no cache side-effect. Clear pull-vs-show guidance in `--help`.

**Single-shot**
- `leebop comment <id> [--body TEXT | --body-file F | --stdin] [--json]`
- `leebop set <field> <id> <value..>` — `title | state | priority | assignee | labels`; labels uses `+foo -bar` delta syntax and `=foo,bar` exact-replace; `description`/`content` deliberately refused with pull→edit→push guidance; cache-refreshed if issue is cached

**Discovery**
- `leebop list [filters...] [--json]` — filters: `--project`, `--project-id`, `--state`, `--state-type`, `--assignee`, `--label` (repeatable), `--priority`, `--updated-since` (`7d|24h|ISO`), `--limit`, `--team`
- `leebop projects [--team --state --json]`
- `leebop teams [--json]`

**Escape hatch**
- `leebop raw <query> [--variables-json FILE|-] [--json]` — query from arg / `--query-file` / stdin; variables from JSON file or stdin

**Cross-cutting**
- `--json` on all read commands (`list`, `projects`, `teams`, `status`, `pull` summary, `show`, `whoami`). Stable versioned schema: `{"schema_version": 1, ...}`.

### Acceptance criteria — verified
**Discovery / read** (real Linear, `UE` workspace)
- [x] `leebop list --assignee me --state-type started` returns current in-flight work; `--json` emits `{schema_version, team, count, issues:[...]}` 
- [x] `leebop teams --json` lists accessible teams; `leebop projects --team UE` lists projects
- [x] `leebop raw 'query { viewer { id email } }'` prints JSON; `--variables-json -` works from stdin

**Bulk read + diff** (real Linear)
- [x] `leebop pull UE-321..UE-329` — 9 issue dirs written; each `description.md` + `metadata.yaml`; comments fetched when present (verified via UE-317)
- [x] `leebop pull --project "Relay Worker Refactor"` produces project dir + child issues; prints target path per entity
- [x] `leebop pull --to /tmp/leebop-test UE-322` — files land at `/tmp/leebop-test/UE-322/`; cache untouched; warning about round-trip printed
- [x] Refuse-overwrite-without-refresh guard works (cache mode only; `--to` bypasses by design)
- [x] `leebop show <id>` — formatted inline read; agent UX verified (subagent resolved the issue with 2 commands: `--help` → `show`)

**Dry-run + guards** (real Linear)
- [x] `leebop push --dry-run` emits correct mutation payload with only the changed field (verified: description-only edit → `{"description":"..."}` in input)
- [x] Non-existent label → `resolveLabelId` throws `unknown label "fake-label"` with candidate suggestions — `--dry-run` caught it before any API call
- [x] CAS staleness — tamper `_server.updated_at` backward → push refuses with clean conflict message pointing at `leebop pull <id> --refresh`
- [x] `leebop status` — local edits detected (description, state, labels); human + `--json` outputs

**Refusals** (static guards, verified)
- [x] `leebop set description <id> ...` refuses at parse time, points at pull→edit→push (tested)

### Acceptance criteria — verified against sentinel UE-351 (2026-04-23)

Sentinel baseline: state=Backlog, priority=0 (none), unassigned, labels=[], description="test test tester mctester test". Revert between runs with the set/push combo documented in progress-log.

- [x] **Real push round-trip:** edited `description.md` locally → `leebop push` → re-pull → remote matched local, `status` clean
- [x] **Real comment:** `leebop comment UE-351 --body "test via leebop <ts>"` → re-pull surfaced the comment file under `issues/UE-351/comments/<uuid>.md`
- [x] **Real set:**
  - [x] `leebop set priority UE-351 urgent` → verified via `show`
  - [x] `leebop set state UE-351 "In Progress"` → verified via `show`
  - [x] `leebop set labels UE-351 +type:test` → verified via `show`; revert via `leebop set labels UE-351 =` (exact-empty replacement)
  - [x] `leebop set assignee UE-351 @me` → verified via `show`; revert via `leebop set assignee UE-351 null`
- [x] `leebop push --force` bypasses CAS — tamper `_server.updated_at` **backward** (not forward; plan wording was wrong — see `push.ts:279`: `remote.updatedAt > _server.updated_at` ⇒ stale). Plain `push` refused with exit=1; `push --force` succeeded.
- [x] **Create + archive via `raw`:** `issueCreate` mutation produced UE-352 in Relayer Hardening / Triage with `type:test` label; `issueArchive` mutation returned `success=true`. Validates `raw` for mutations (previously only query was verified).
- [ ] Interactive `leebop auth login` (no flags; hidden-input prompt) — codepath typechecks, **still user-verifiable-only**

### Deferred from Phase 1 (not yet implemented)
- [ ] `leebop pull` space-separated list of IDs (tested range `UE-321..UE-329` and single; not `UE-321 UE-322 UE-323` — code supports it, untested in session)
- [ ] `leebop pull --no-comments` flag exercise
- [ ] Multi-issue push in one invocation (path exists; tested only with 1 modified issue at a time)
- [ ] `leebop projects --state <state>` filter (code present, not exercised)
- [ ] `leebop list --label foo --priority 1` (filter combinations beyond what was tested)

**Actual size:** ~1,350 LOC across 13 source files (original estimate ~450; growth was in cache/diff/build/resolve infrastructure that's reused across verbs).

---

## Phase 2 — Projects round-trip + issue linking ⬜

Project pull already works from Phase 1 (`leebop pull --project`). What's left:

### Scope
- **Project push:** `leebop push` already has the project branch coded (see `src/commands/push.ts`, `PROJECT_UPDATE_MUTATION`), untested against real Linear
- **Issue linking:** `leebop set links <id> +blocks:X,-related:Y,duplicates:Z` — delta syntax; maps to Linear's `IssueRelation` create/delete mutations; ships as a new field under `set`

### Acceptance
- [ ] `leebop pull --project "<name>"` → edit `content.md` → `leebop push` mutates project content in Linear (verify via re-pull)
- [ ] Project push does **not** touch child issues unless they're also modified
- [ ] `leebop set links <id> +blocks:<id2>` creates the blocks relation (verify via Linear UI or re-pull)
- [ ] Re-running the same `+blocks:` is idempotent (no duplicate relation)
- [ ] `leebop set links <id> -blocks:<id2>` removes it

**Estimated size:** ~120 additional lines.

**Linking GraphQL shape — verified via `leebop raw` probe (2026-04-23):**

```graphql
# CREATE — idempotent at the (issueId, relatedIssueId, type) tuple
mutation ($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation { id type issue { identifier } relatedIssue { identifier } }
  }
}
# input = { type: IssueRelationType!, issueId: String!, relatedIssueId: String! }
# (id is optional; server generates)

# DELETE — takes the relation's own UUID, not the issue pair
mutation { issueRelationDelete(id: "<relation-uuid>") { success } }

# READ — both outbound and inbound
query { issue(id: "UE-351") {
  relations { nodes { id type relatedIssue { identifier } } }          # outbound
  inverseRelations { nodes { id type issue { identifier } } }          # inbound
} }
```

`IssueRelationType` enum: `blocks | related | duplicate | similar` (note `similar` — undocumented in our spec, likely unused but exists).

**Key design implications for `set links`:**
- Create is server-side-idempotent: agents don't need to pre-check for existing relations before adding. `+blocks:UE-X` on an already-blocking issue is a no-op, not an error.
- Delete requires the **relation UUID**, not the (source, target, type) tuple. `set links <id> -blocks:UE-X` implementation must:
  1. Read `issue.relations.nodes` to find the relation UUID matching `(type=blocks, relatedIssue.identifier=UE-X)`
  2. Call `issueRelationDelete(id: <found-uuid>)`
- For displaying relations in `show`, fold `relations` (outbound) and `inverseRelations` (inbound) — an issue "blocked by" something shows up in `inverseRelations` as type `blocks`.

---

## Phase 3 — Linter + auto-fix ⬜

### Scope
- `src/lib/quirks.ts` — universal rules (L001–L005 per `spec.md` §9.1)
- `src/lib/lint.ts` — rule runner with severity + auto-fix hooks
- Repo-scoped rules (R001–R002) loaded from `config.yaml`
- `leebop lint [PATHS...] [--fix] [--strict]`
- `leebop push` integrates lint; `--strict` push blocks on warnings

### Acceptance
- [ ] Lint against a table cell = `1. Foo` emits `L001` warning
- [ ] `leebop lint --fix` rewrites `1. Foo` → `Row 1 — Foo` without mangling adjacent cells
- [ ] Lint against a description containing a configured `path_rewrites.from` prefix emits `R001` and applies `to` prefix on `--fix`
- [ ] `leebop push --strict` refuses to push content with outstanding `L001` / `R001` warnings
- [ ] Table-driven fixture tests under `tests/quirks/`

**Estimated size:** ~100 additional lines.

---

## Phase 4 — Polish ⬜

- [ ] `leebop diff <id>` — unified diff vs live remote (with `--json`). Fetch fresh remote → diff against local. Partial overlap with `show` + `status`; may become `status --diff <id>` instead of a separate verb.
- [ ] `leebop new --from <template|yaml>` — template-driven issue creation (bulk + single); reuses cache file format
- [ ] Slash commands under `~/.claude/commands/`: `/leebop-pull`, `/leebop-push`, `/leebop-lint`
- [ ] `SKILL.md` at `~/.claude/skills/leebop/SKILL.md` — agent-focused guidance (when to use which verb, the pull→edit→push mental model, `show` vs `pull` distinction)
- [ ] Short-alias CLIs if ergonomics demand
- [ ] Git pre-commit hook on leebop's own repo — self-lint fixtures
- [ ] **App-actor OAuth** (from spec §11): register a Linear OAuth app, implement PKCE, use `actor=app` so agent mutations attribute to a separate identity in Linear's audit log

`show` was originally a Phase 4 idea but got promoted to Phase 1 after the agent UX test.

---

## Test strategy

**Current reality:** zero tests written. Everything verified this session was interactive/manual.

### What to write first (before Phase 2)
1. **Vitest unit tests** on pure functions — `diff.ts`, `resolve.ts`, `expand.ts`, `config.ts`. No network, no SDK. Fast. **🟢 Done 2026-04-23 — 51 tests across 4 files in `tests/`, all passing (~0.4s run).**
2. **Integration test harness** against a real sentinel issue in `UE`:
   - `.leebop-test-target.yaml` at repo root names the team + sentinel ID
   - Tests gated on `LEEBOP_TEST_SENTINEL` env var (set to the identifier)
   - `test.skipIf(!process.env.LEEBOP_TEST_SENTINEL)` on integration suites
   - Teardown must reset sentinel's fields (title/state/priority/labels/assignee) to known values; store expected baseline in the yaml
3. **Table-driven linter tests** once Phase 3 lands.

### What not to do
Don't mock `@linear/sdk`. The whole point is catching Linear's real behavior (renderer quirks, undocumented filter constraints). Mocks would have let `IssueFilter.identifier` pass code review — it doesn't exist on Linear's schema, and we only discovered that at runtime.

---

## Progress log

Append-only. Most recent at bottom.

- **2026-04-22** — spec + implementation plan drafted. No code.
- **2026-04-22** — revised scope: leebop owns the full agentic Linear surface (auth, discovery, bulk round-trip, single-shot edit, GraphQL escape hatch). Native PAK auth replaces shelling out to `@schpet/linear-cli`. Phase 1 estimate bumped 200 → 450 lines. Comment-read moved Phase 2 → Phase 1. Issue linking added to Phase 2.
- **2026-04-22** — Phase 0 🟢 complete. Project scaffolded on Bun 1.3.13 with `@linear/sdk@82`, strict TS, biome. CLI dispatcher + all subcommand registrations wired; unimplemented commands stubbed via `notImplemented()` so `leebop --help` already shows the full surface. Native PAK auth shipped: `auth login/logout/whoami [--refresh] [--json]`, with `--from-schpet` migration and PAK-vs-OAuth token discrimination. End-to-end verified via `--from-schpet`; `auth.json` persisted at mode 0600 (dir 0700). Commit `19dd34e`.
- **2026-04-22** — Phase 1 🟡 code-complete (~1,350 lines). All verbs shipped. Read paths verified end-to-end against `UE` workspace + `Relay Worker Refactor` project. Discovered: `IssueFilter` doesn't expose `identifier` → use multi-alias GraphQL via `issue(id: "…")`. Multi-file cache design with `_server:` snapshot (incl. description hash) for cheap status diff. Team metadata cache with 1h TTL. Sentinel-issue mutation verification blocked pending user designation. Commit `7a77f4b`.
- **2026-04-22** — Agent-UX smoke test. **Round 1 failed silently**: subagent couldn't find `leebop` on its PATH and fell back to `@schpet/linear-cli`. Root cause: `bun link` places bins in `~/.bun/bin`, which Claude Code subagents don't inherit even after the user edits `~/.zshrc`. **Fix:** symlink `~/.bun/bin/leebop → /opt/homebrew/bin/leebop` (sudo-free; universally on PATH). **Round 2 succeeded**: subagent discovered leebop via `--help`, pulled UE-322, produced correct summary. Two UX gaps surfaced and fixed: (1) `pull` didn't print where files landed → now prints full cache path; (2) no read-only "just show me this issue" verb → added `leebop show <id>`. Also added `leebop pull --to <dir>` export mode. README rewritten with install + comparative overview of production CLI install patterns. Commit `5c0c0ab`.
- **2026-04-22** — Session close: Phase 1 paused awaiting sentinel-issue designation for mutation-path verification. All Phase 1 code shipped, all read paths verified. Implementation plan rewritten for clean resumption.
- **2026-04-23** — **Phase 1 🟢 closed.** Sentinel UE-351 designated (Backlog / Relayer Hardening / unassigned / no labels / description `"test test tester mctester test"`). Full mutation battery executed end-to-end against real Linear: push roundtrip (description edit), comment add, `set priority/state/labels/assignee`, CAS conflict + `--force` bypass. All reverted to baseline. Also: throwaway UE-352 created via `leebop raw issueCreate` in Triage / `type:test` / Relayer Hardening, then archived via `leebop raw issueArchive` — validates `raw` for mutations (previously only query verified) and proves the create-path ahead of Phase 4's `leebop new`. **Corrections to plan**: CAS refusal triggers on tamper-**backward** of `_server.updated_at`, not forward (code: `push.ts:279`). **New quirk discovered**: `leebop set labels <id> -foo` alone fails because commander parses leading `-` as an option flag — workaround via `+` prefix first or `=` exact-replace. Logged under Discovered quirks.
- **2026-04-23** — Pre-Phase-2 foundations. **Unit tests landed**: 4 files under `tests/` (`expand`, `diff`, `resolve`, `config`) covering pure libs; 51 tests pass in ~0.4s. tsc + biome green. **`issueRelation*` probe complete** — mutation shapes + enum values + idempotency semantics captured in § Phase 2. Headline finding: server-side idempotent create (same tuple → same UUID, no dup) and delete requires relation UUID (must look up before deleting via `-` delta). Also: surfaces design call to promote `leebop new` + `leebop archive` out of `raw` into first-class verbs (usage signal from this session's test workflow) — user input pending before committing to Phase 2.5 slot.
- **2026-04-23** — **Phase 2 🟢 + Phase 2.5 🟢 shipped.** `leebop new` (create issue with `--title/--project/--state/--priority/--label/--assignee/--description(-file|--stdin)`), `leebop archive <id...>`, and `leebop set links <id> +/-KIND:TARGET` (5 kinds: `blocks | blocked-by | duplicates | duplicated-by | related`; `similar` intentionally in `raw` only). `show` now folds `relations + inverseRelations` into a `── links ──` section. Ships with 11 new unit tests for `parseLinkToken` (62 total, all green). **Live-verified** via TEST-C/TEST-D pair (UE-355 + UE-356 — both created via `leebop new`, linked in every directional variant, then archived via `leebop archive`). **Two significant Linear semantic quirks discovered during live-test, now logged**: (1) Linear enforces AT MOST ONE relation per issue pair — `+related:X` silently replaces any pre-existing `+blocks:X` or reverse-direction relation, which makes `+`/`-` delta semantics misleading when multiple deltas hit the same pair; (2) creating any `duplicate`-type relation may auto-move the involved issues to the `Duplicate` workflow state (type: `canceled`). Both documented under Discovered quirks. Same commander `-foo`-as-option bug hit `set links` as it did `set labels` — workaround: `--` separator or prefix with `+`. Logged as Immediate next step #1 for a UX fix.
- **2026-04-23** — **UX fix: commander `-foo` bug in `set labels` + `set links` fully resolved.** `src/lib/argvPrep.ts::preprocessSetArgv` walks past `set FIELD ID` (accounting for `--team <val>`/`--team=val` and `--json`/`-h`/`--help`), then auto-inserts a `--` separator before the first unknown `-TOKEN` it encounters. Invariant: only touches `set` argv; leaves every other invocation alone; no-op if `--` already present. 14 new unit tests (76 total). **Live-verified** via TEST-E/TEST-F pair (UE-357 + UE-358, archived) — exercised single-negative (`-type:test`, `-blocks:UE-358`), mixed `+/-` sequences, `--json -blocks:…` co-existence, and explicit `--` back-compat. All five paths green. `leebop set labels UE-351 -type:test` and `leebop set links UE-355 -blocks:UE-356` now Just Work.
- **2026-04-23** — **End-to-end shakedown + four polish fixes.** Walked every verb path against the sandbox: discovery (teams/projects/list with all filter combos), pull (single/list/range/project/--refresh/--no-comments/--to/--json), show, set (every field + edge cases), new, archive, push (multi-issue + --json), comment (--body/--body-file/--stdin), raw (--query-file + --variables-json from file & stdin), CAS+--force. Found and fixed: (1) **`pull` fail-fast on mixed valid+invalid IDs** — Linear SDK throws and discards partial data when ANY alias errors; fix: try multi-alias happy path, fall back to per-id `Promise.allSettled` so successes survive. (2) **Raw GraphQL not-found error surfaced** on `show`/`archive`/`pull` — added `src/lib/errors.ts::rewriteNotFound` (tiny translator used at catch sites; not a wrapper) and applied in those three commands. (3) **Team-metadata 1h TTL blocked `--project <name>` for freshly-created projects** — added `withFreshMetadataOnMiss` in `resolve.ts` that auto-retries with `refresh: true` on `ResolveError`; applied to `new` and `set`. **Sandbox baseline corrected**: UE-359/UE-360 moved from Triage → Backlog (Triage bloats Linear's global cross-project triage view). New unit tests (4 in `tests/errors.test.ts`); 80 total, all green.
- **2026-04-23** — **Persistent test sandbox + full regression + Phase 2c 🟢 + latent bug fix.** Created a dedicated `leebop sandbox` Linear project (UUID `88377408-3d52-49f8-87c3-0d0f550cc9df`) via `leebop raw projectCreate`, moved all mutation-path testing inside it (`feedback_no_real_linear_mutations.md` rewritten; `reference_leebop_sandbox.md` added). Populated with two persistent sentinels: **UE-359** (issue mutation regression) and **UE-360** (links partner). Ran full end-to-end regression: push roundtrip, comment, set (priority/state/labels/assignee), CAS-conflict + `--force`, all 5 `set links` directions, `show` link rendering both sides, project pull → edit content.md → push → re-pull. **Found and fixed a latent cache-hash-drift bug** in `src/commands/push.ts`: after issue/project update, we were writing `plan.{description,content}` (local pre-push) back to disk but setting `_server.{description_hash,content_hash}` from the server response — Linear's markdown renderer normalizes on push (adds blank lines around `---`; converts `text\n---` to `## text` setext H2), so the two diverged and `status` stayed stuck on "modified" until the user ran `--refresh`. Now we write the server's normalized form, so cache stays clean immediately after push. Two new Discovered quirks logged: (1) Linear markdown normalization behaviors with specific examples; (2) team-metadata 1h TTL makes `--project <name>` fail on freshly-created projects — UX improvement queued as Immediate next step #2.

---

## Discovered quirks (running list)

Facts that cost time or were non-obvious on first encounter. **Don't rediscover — check here first.** Promote to `spec.md` when they're stable enough to codify.

### Linear API / SDK
- **`IssueFilter` has no `identifier` field.** `issues(filter: { identifier: { in: [...] } })` → error `Field "identifier" is not defined by type "IssueFilter"`. Workaround: multi-alias query — `issue(id: "TEAM-NN")` accepts either UUID or identifier. See `src/lib/pullQuery.ts::buildPullIssuesQuery`.
- **`@linear/sdk` `accessToken` vs `apiKey` matters.** `accessToken` prepends `Bearer ` to the Authorization header; `apiKey` uses the token as-is. Personal API keys (`lin_api_...`) must go through `apiKey`; OAuth tokens (from schpet) through `accessToken`. Discrimination via prefix in `src/lib/auth.ts::linearClientFromToken`.
- **`Issue.identifier` is a virtual field**, but `Issue(id: "…")` accepts both the UUID and the identifier string. Handy for pull; still not a filter field.
- **`updatedAt` CAS is entity-level, not field-level.** Any edit bumps it, so CAS refusal can be a false positive when two users edited unrelated fields between pull and push. Accepted trade-off; `--force` is the escape. See spec §10.7.
- **`issueUpdate.input.labelIds` REPLACES**, it doesn't merge. `push` fetches the current label set, computes the target set client-side, and submits the full replacement. `set labels` uses `+/-` delta syntax to hide this from the user.
- **Linear's `viewer.name` may equal their email** (observed: `justice@unlink.xyz` is both `name` and `email`). Don't assume `name` is distinct from `email`.
- **`issueRelationCreate` is server-side idempotent** at the `(issueId, relatedIssueId, type)` tuple. Running the same create twice returns the existing relation UUID, doesn't duplicate. `issueRelationDelete` takes the relation UUID (not the issue pair) — for a delta like `-blocks:UE-X`, you must first query `issue.relations.nodes` to find the matching relation and its UUID.
- **Linear enforces AT MOST ONE relation per issue pair.** Adding `+related:UE-X` when `+blocks:UE-X` already exists **silently replaces** it — `issueRelationCreate` returns `success: true` but the prior relation is gone. Same for reversing direction: `+blocked-by:UE-X` replaces a pre-existing `+blocks:UE-X`. This makes the `+/-` delta semantics in `set links` misleading when multiple deltas target the same other-issue — each `+` against the same pair overwrites. Agents should either (a) target different issues per delta, or (b) accept that the last `+KIND:X` against a given pair wins.
- **Creating a `duplicate`-type relation can trigger auto-state-changes on the involved issues** to the `Duplicate` workflow state (type: `canceled`). Observed empirically: after a chain of `+duplicates:X → +duplicated-by:X` on the same pair (triggering a replacement), both the subject and target ended up in `Duplicate` state. The trigger is probably Linear's internal "mark as duplicate" workflow, not a pure GraphQL mutation. **Warn users** (or just document) that `set links +duplicates:X` or `+duplicated-by:X` may move the issue out of its current workflow state.
- **`IssueRelationType` includes `similar`** in addition to the `blocks | related | duplicate` documented in spec §Phase 2 scope. `set links` deliberately omits it from the surface — use `leebop raw` if ever needed.
- **`issueCreate` input requires `teamId` as UUID** (not the key like "UE"). Resolve via cached team metadata. Same pattern as `stateId`, `labelIds`, `assigneeId`, `projectId`.
- **`issueArchive(id: String!)` takes the issue UUID** (not identifier). `{ success }` response. Archive is reversible from the Linear UI — treat as safe.
- **`projectCreate` requires `teamIds: [String!]!` and `name: String!`.** Everything else (description, content, statusId) is optional; state defaults to `backlog`. `statusId` replaced the older `state` enum — look up valid statuses via the `ProjectStatus` query if needed; absent statusId is fine for a backlog project.
- **Linear re-renders markdown on every `issueUpdate` / `projectUpdate`.** Common normalizations observed: (a) blank lines inserted around `---` horizontal-rule dividers; (b) `text\n---\n...` reparsed as `## text` (setext H2 heading) — aggressive transformation of the leading line. `push.ts` now writes the server's normalized `description` / `content` to disk so `_server.*_hash` matches the file (earlier versions wrote the pre-push local version, leaving a permanent hash drift that kept `status` stuck on "modified" until `--refresh`).
- **Team metadata has a 1h TTL** and doesn't auto-refresh when leebop itself creates new projects/labels/states. **Worked around 2026-04-23** via `withFreshMetadataOnMiss` in `src/lib/resolve.ts`: name → UUID lookups in `new` and `set` now auto-refresh metadata once on `ResolveError` and retry. Push paths still use the cached metadata (low risk — push only references entities the user already has IDs for).
- **Linear SDK's `client.client.rawRequest` throws on ANY GraphQL error and discards `data`.** The thrown error has top-level `data`, `errors`, `query`, `type`, `status`, `raw` fields (NOT `response.data` like graphql-request's ClientError). For multi-alias queries with partial errors, this means successful aliases are LOST. `pull` works around this by falling back to per-id `Promise.allSettled` on multi-alias failure (one extra round-trip on failure paths; happy path stays single-request).

### Tooling / environment
- **`bun link` doesn't put binaries on the PATH agents inherit.** `~/.bun/bin` is an interactive-shell-only PATH addition. Subagents (and Claude Code itself) inherit the PATH of the process that started them. Fix: symlink the `bun link`-ed bin into `/opt/homebrew/bin` (macOS) or `/usr/local/bin` (Linux) — those dirs are universally on PATH. Documented as a required install step in `README.md`.
- **Commander treats leading `-` as an option flag in variadic args.** `leebop set labels UE-351 -type:test` would otherwise fail with `error: unknown option '-type:test'` because the variadic `<value...>` still runs through the option parser. **Fixed 2026-04-23** via `src/lib/argvPrep.ts::preprocessSetArgv`, which walks past `set FIELD ID` (respecting the known set options `--team` and `--json`) and auto-inserts a `--` separator before the first remaining unknown `-TOKEN`. Users can type `-type:test` or `-blocks:UE-X` naturally; back-compat with explicit `--` preserved. Covered by 14 unit tests in `tests/argvPrep.test.ts`.
- **Bun's default tsconfig uses `"module": "Preserve"` and `"moduleResolution": "bundler"`**, not `NodeNext`. That's correct for a bun-native app; NodeNext is what we'd use only for a Node+tsx fallback. Spec mentions NodeNext — that was generic TS advice, not mandatory.
- **`client.client.rawRequest(query, variables)` is the public escape hatch** in `@linear/sdk`. `.client` is typed, `rawRequest` is typed. No `@ts-expect-error` needed.
- **Biome's organizeImports is aggressive.** Put `type` imports separate from value imports; it'll reorder anyway. Acceptable; just run `bunx biome check --write` and commit.

### Tests
- **`@schpet/linear-cli 2.0.0`'s `linear auth token` command returns an OAuth bearer** (not a PAK). That's why `--from-schpet` works with `accessToken`, not `apiKey`, and why the discrimination check is needed.
- **Sanity probe for any new GraphQL query:** run it through `leebop raw '…'` first to confirm the schema accepts it before coding the wrapper.

---

## Open questions — running log

Mirror of `spec.md` §12 plus anything surfaced during build. Answer inline as resolved.

| # | Question | Current state | Resolved? |
|---|---|---|---|
| 1 | Name-resolution on ambiguous label/state prefix | exact match, fail with candidate list. Implemented in `resolveLabelId` / `resolveAssigneeId`; `resolveStateId` requires exact case-insensitive match. | 🟢 |
| 2 | Cache location when not in a git repo | `~/.leebop/cache/_global/` + `default_team` fallback. Implemented in `resolveConfig` via `GLOBAL_REPO_ROOT`. | 🟢 |
| 3 | Batch size for `updatedAt` CAS checks | unlimited multi-alias (one call per `push` invocation); benchmark if push gets called on 50+ issues. | 🟡 deferred |
| 4 | `--project NAME` pulls issues by default? | yes; no `--no-issues` flag implemented — may add if project-only pulls become common. | 🟢 for now |
| 5 | App-actor OAuth timing | defer until audit-trail noise observed. Still deferred. | ⬜ |
| 6 | `leebop set` field-set stability | title/state/priority/assignee/labels shipped; links in Phase 2; description/content refused (points at pull→edit→push). | 🟢 |
| 7 | How do `pull --to <dir>` files participate in push/status? | **Export-only for v1.** Cache is canonical for round-trip. Files in `--to` are leaf copies for agent reference next to code; edits there don't round-trip. Warning printed on pull. | 🟢 |
| 8 | Install / PATH story | Required step: symlink `~/.bun/bin/leebop → /opt/homebrew/bin/leebop`. Documented in README. A `curl | bash` installer is a Phase 4 polish item. | 🟢 for now |

---

## Resumption checklist

If you're picking this up cold (new agent or returning developer):

1. **Read `docs/spec.md` end-to-end.** Stable design — architecture, file formats, verified Linear facts, command surface, rejected alternatives.
2. **Read this file's TL;DR, Current state, and Immediate next steps.** Don't re-read the entire Progress log unless you want history — the "Current state" + "Immediate next steps" summarize the actionable present.
3. **Verify preconditions** (**§ Preconditions for any development** above): `which leebop`, `leebop auth whoami`, `bun --version`.
4. **Run `leebop --help`** to confirm the surface matches this doc. If a verb is missing or extra, this doc is stale — reconcile before coding.
5. **Consult Source map** to find the right file for your task.
6. **Consult Discovered quirks** before writing any Linear-touching code. Most costly bugs in prior sessions would have been avoided by reading this list first.
7. **Pick the first ⬜ checkbox in the current phase.** Currently: **§ Phase 2** (project push live-verify + `set links`). Pre-Phase-2 test coverage is called out in **§ Test strategy**.
8. **On any new quirk: append to Discovered quirks BEFORE fixing** so the knowledge survives the fix.
9. **Before committing any code:** `bunx tsc --noEmit` + `bunx biome check src/` both green. `bunx biome check --write src/` to auto-fix formatting.
10. **Commit convention:** present-tense subject lines, scope prefix (`feat:`, `docs:`, `fix:`). Include a short "why" in the body. Don't commit without running the tsc+biome gate.

### Human-only steps
- **Designating a sentinel issue** (step 1 of Immediate next steps) — can't be automated; needs a real choice of Linear issue you're OK mutating for tests.
- **App-actor OAuth registration** (Phase 4) — requires logging into Linear and registering an OAuth application; store `client_id` in code, `client_secret` as an env var.
