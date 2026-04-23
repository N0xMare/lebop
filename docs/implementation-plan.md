# leebop — implementation plan

Living document. Update as phases progress, quirks emerge, questions resolve. Paired with `spec.md` (stable design).

**Status legend:** ⬜ not started · 🟡 in progress · 🟢 done · ⏸ blocked

---

## TL;DR — where we are

- **Phase 0 (bootstrap + auth):** 🟢 shipped.
- **Phase 1 (MVP agentic read/write surface):** 🟡 code-complete (~1,350 LOC), all read paths verified end-to-end against real Linear, all write paths verified via `--dry-run` only. **Mutation-path verification blocked pending user designation of a sentinel issue.**
- **Next concrete step:** pick a sentinel issue (or dedicated test issue) in team `UE`, then run the three mutation tests in **§ Phase 1 acceptance — pending**.

If you're a new agent reading this, jump to **§ Resumption checklist** below.

---

## Current state

| Phase | Status | What's in / what's out |
|---|---|---|
| 0. Bootstrap + native auth | 🟢 | scaffolding, CLI dispatcher, native PAK auth (`leebop auth login/logout/whoami`) |
| 1. MVP — agentic read/write surface | 🟡 | all verbs implemented; `show`, `pull --to`, path-on-success shipped. Reads + dry-runs verified. Mutations pending sentinel. |
| 2. Projects round-trip + issue linking | ⬜ | project pull already works (Phase 1); push and `set links` pending. |
| 3. Linter + auto-fix | ⬜ | — |
| 4. Polish | ⬜ | `leebop new`, slash commands, SKILL.md, git pre-commit, `leebop diff` remaining. (`show` promoted to Phase 1.) |

Verified install / environment state on the development machine (as of last session):
- **Bun 1.3.13** on macOS (darwin 24.6.0, arm64)
- **Symlink:** `/opt/homebrew/bin/leebop → /Users/cmace/.bun/bin/leebop` exists and is on the PATH inherited by Claude Code subagents.
- **Auth:** `~/.leebop/auth.json` present (token was imported via `--from-schpet`; viewer = `justice@unlink.xyz`, team `UE`, workspace `unlink-xyz`).
- **Config:** `~/.leebop/config.yaml` seeded with `default_team: UE` and workspace URL prefix.
- **Cache:** `~/.leebop/cache/5102b4186605/` (repo hash for `/Users/cmace/dev/unlink/leebop`) — contains pulled fixtures for `UE-321..UE-329` and project `Relay Worker Refactor`.

---

## Immediate next steps (in order)

1. **Designate a sentinel issue in UE** — an existing issue you're comfortable mutating, OR a new `TEST: leebop sentinel` issue. Record its identifier here and in a `.leebop-test-target.yaml` when the integration-test harness lands.
2. **Run the three pending mutation tests** (see **§ Phase 1 acceptance — pending** below). Each takes seconds. Revert via `leebop pull <id> --refresh` after.
3. **Flip the mutation checkboxes, close Phase 1.**
4. **Start Phase 2** (projects round-trip + issue linking) — see **§ Phase 2** for scope.

Everything else (tests, linter, polish) is downstream of closing Phase 1.

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
│   ├── show.ts               # read-only single-issue display (no cache side-effect)
│   ├── pull.ts               # cache materialization; --to for export-mode
│   ├── push.ts               # CAS-guarded mutation; --dry-run
│   ├── status.ts             # git-like diff against _server snapshot
│   ├── diff.ts               # (stub) Phase 4
│   ├── lint.ts               # (stub) Phase 3
│   ├── comment.ts            # add a comment (direct mutation)
│   ├── set.ts                # single-shot field mutations with name→UUID
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
    ├── pullQuery.ts          # multi-alias issue query builder + fragment + types
    ├── pushMutations.ts      # issueUpdate/projectUpdate + batched CAS query builder
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

### Acceptance criteria — pending (sentinel issue required)

Run these once a sentinel issue is designated. Each should complete in seconds; revert between runs with `leebop pull <sentinel> --refresh`.

- [ ] **Real push round-trip:** edit sentinel's `description.md` locally → `leebop push` → re-pull → confirm the edit landed in Linear and `status` is clean
- [ ] **Real comment:** `leebop comment <sentinel> --body "test via leebop $(date +%s)"` → verify the comment appears when re-pulled
- [ ] **Real set:**
  - [ ] `leebop set priority <sentinel> urgent` → verify via `show`
  - [ ] `leebop set state <sentinel> "<a state name>"` → verify via `show`
  - [ ] `leebop set labels <sentinel> +<known-label> -<known-label>` → verify via `show`
  - [ ] `leebop set assignee <sentinel> @me` → verify via `show`
- [ ] `leebop push --force` bypasses CAS (tamper `_server.updated_at` forward, `--force`, confirm it pushes anyway)
- [ ] Interactive `leebop auth login` (no flags; hidden-input prompt) — `auth logout`, then `auth login`, paste a PAK manually

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

**Linking requires GraphQL we haven't touched yet:** `issueRelationCreate` / `issueRelationDelete`. The `IssueRelation` type in `@linear/sdk` has `type: "blocks"|"related"|"duplicate"`. Worth a quick probe via `leebop raw` before coding.

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
1. **Vitest unit tests** on pure functions — `diff.ts`, `resolve.ts`, `expand.ts`, `config.ts`. No network, no SDK. Fast.
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

### Tooling / environment
- **`bun link` doesn't put binaries on the PATH agents inherit.** `~/.bun/bin` is an interactive-shell-only PATH addition. Subagents (and Claude Code itself) inherit the PATH of the process that started them. Fix: symlink the `bun link`-ed bin into `/opt/homebrew/bin` (macOS) or `/usr/local/bin` (Linux) — those dirs are universally on PATH. Documented as a required install step in `README.md`.
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
7. **Pick the first ⬜ checkbox in the current phase.** Currently: **§ Phase 1 acceptance — pending** (sentinel mutation tests).
8. **On any new quirk: append to Discovered quirks BEFORE fixing** so the knowledge survives the fix.
9. **Before committing any code:** `bunx tsc --noEmit` + `bunx biome check src/` both green. `bunx biome check --write src/` to auto-fix formatting.
10. **Commit convention:** present-tense subject lines, scope prefix (`feat:`, `docs:`, `fix:`). Include a short "why" in the body. Don't commit without running the tsc+biome gate.

### Human-only steps
- **Designating a sentinel issue** (step 1 of Immediate next steps) — can't be automated; needs a real choice of Linear issue you're OK mutating for tests.
- **App-actor OAuth registration** (Phase 4) — requires logging into Linear and registering an OAuth application; store `client_id` in code, `client_secret` as an env var.
