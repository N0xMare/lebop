# lebop

**Best-for-agents Linear tool.** Read, write, and plan Linear projects from your shell or an AI agent, without leaving your editor. Treats Linear issues as markdown files you can edit, diff, and apply — the same way you already work with code. Ships as a CLI and an MCP server sharing one library core.

Two shapes:

- **Ad-hoc ops** — `list`, `show`, `set`, `comment`, `new`, `archive`, `pull` / `edit` / `push`, `diff`, `raw` GraphQL escape hatch.
- **Declarative planning** — author a project + its issues + their relationships as a directory of markdown files, then `lebop plan apply` realizes the whole graph in Linear in one idempotent pass.

Think: `git`, but for Linear.

---

## Quick start

```sh
# 1. Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# 2. Clone + install lebop
git clone <repo-url>
cd lebop
bun install
bun link
ln -sf "$HOME/.bun/bin/lebop" /opt/homebrew/bin/lebop   # macOS; /usr/local/bin on Linux

# 3. Authenticate with a Linear Personal API Key (Settings → API in Linear)
lebop auth login

# 4. Try it
lebop teams
lebop list --assignee me --state-type started --limit 10
```

Per-user config lives at `~/.lebop/config.yaml`; auth at `~/.lebop/auth.json` (mode 0600); local cache at `~/.lebop/cache/<repo-hash>/`. **Your repo working tree stays pristine — all runtime state is in `~/.lebop/`.**

Full setup, config, and command reference: [`docs/spec.md`](docs/spec.md).

---

## Mental model: pick the right verb for what you want to do

### Discover

```sh
lebop teams
lebop projects [--team KEY] [--state STATE]
lebop list --assignee me --state-type started
lebop list --project "Relayer Hardening" --label type:feature
```

### Read one issue

```sh
lebop show UE-321                 # print inline, no cache write — the right "just show me this"
lebop show UE-321 --json          # structured output for programmatic use
```

### Edit one field on one issue (fast, no cache round-trip)

```sh
lebop set state UE-321 "In Progress"
lebop set priority UE-321 urgent                 # name or 0..4
lebop set labels UE-321 +urgent -area:backend    # delta syntax
lebop set assignee UE-321 @me
lebop set links UE-321 +blocks:UE-322 +related:UE-323   # 5 link kinds
lebop comment add UE-321 --body "LGTM"
```

### Edit a body (multi-line description / project content)

```sh
lebop pull UE-321..UE-329                         # or space-separated list, or single id
# ... edit files under ~/.lebop/cache/<hash>/issues/UE-321/description.md ...
lebop status                                      # git-like: see what's modified
lebop push --dry-run                              # preview mutations
lebop push                                        # apply (CAS-protected; --force to bypass)
```

`lebop push` runs the linter first — warnings print to stderr, `--strict` blocks. After success the cache stays clean immediately, no `--refresh` needed.

### Create or archive issues ad-hoc

```sh
lebop new --title "Chain-aware gas pricing" \
           --project "Relayer Hardening" \
           --state Backlog \
           --priority high \
           --label type:feature \
           --description "Use eth_feeHistory to size initial bids."

lebop archive UE-321 UE-322                       # reversible from the Linear UI
```

### Plan a whole initiative declaratively (the hero workflow)

Author the plan in markdown on disk:

```
plans/rpc-failover/
├── _project.md            # name / team / description / body
├── epic.md                # top-level issue (can have sub-issues via `parent:`)
├── design.md              # has `parent: epic` → renders as a sub-issue in Linear
├── impl.md                # same
└── bench.md               # links, labels, priorities, estimates
```

Each `*.md` file has YAML frontmatter for structured fields and markdown body for the description:

```markdown
---
title: "Design failover priority algorithm"
state: Backlog
priority: high
estimate: 3                # points (optional)
labels: [type:feature]
parent: epic               # slug of another file, or bare UE-XXX
blocks: [impl]             # local slug OR external UE-XXX
related: [UE-250]
---

Approach doc. Multi-RPC failover selection rules, …
```

Then realize it in Linear:

```sh
lebop plan validate plans/rpc-failover          # parse + resolve refs; no Linear writes
lebop plan lint     plans/rpc-failover --fix    # catch markdown-renderer gotchas first
lebop plan apply    plans/rpc-failover --dry-run   # preview
lebop plan apply    plans/rpc-failover             # create project + issues + links; writes linear_id back
lebop plan diff     plans/rpc-failover             # local-vs-remote drift after changes
lebop plan pull     plans/rpc-failover --force     # overwrite local with remote
lebop plan pull     plans/rpc-failover --include-new  # also import remote-only issues
```

Re-apply is idempotent — unchanged files stay unchanged. Parents get created before children (topological). Slug links auto-rewrite to `UE-XXX` once issues exist. Relations (`blocks` / `blocked_by` / `related` / `duplicates` / `duplicated_by`) honor Linear's single-record-per-pair semantics.

See [`docs/spec.md`](docs/spec.md#9-plan-workflow--declarative-authoring) for the full frontmatter schema, apply semantics, and edge cases.

### Diff + escape hatch

```sh
lebop diff UE-321                                  # unified diff of local cache vs live remote
lebop raw 'query { viewer { id email } }'          # any GraphQL lebop doesn't wrap
echo '{"id":"UE-321"}' | lebop raw 'query($id:String!){issue(id:$id){title}}' --variables-json -
```

### Lint local markdown against Linear's renderer

```sh
lebop lint                                       # scans ~/.lebop/cache/<hash>/ by default
lebop lint path/to/some.md --fix                 # explicit paths; --fix applies safe rewrites
lebop lint --strict                              # exit non-zero on warnings (pre-commit gate)
```

Rules catch Linear's markdown landmines (table-cell `1.` breaking rows, `text\n---` silently becoming a setext H2, etc.) plus optional repo-scoped rules (bracketed issue refs, path rewrites, custom regex formats) driven by per-repo config.

---

## Team collaboration — important hazard

Plan files are git-tracked **source of truth**, but `linear_id:` is written back into each file by `plan apply`. If two teammates both run `plan apply` on the same plan directory **before the writeback commits land in git**, you get **duplicate issues in Linear** (each apply creates fresh ones with no shared identifier).

**Workflow for shared plans:**

1. One person ("first-applier") runs `lebop plan apply <dir>`.
2. **Immediately** commit the writeback (`git add <plan-dir>` → commit → push).
3. Everyone else pulls that commit **before** touching the plan.
4. From then on, `apply` / `diff` / `pull` by anyone on the team targets the same Linear entities.

If two people already applied in parallel: archive one set via `lebop archive <ids...>` + `lebop raw projectArchive`, then rewrite the plan files to reference the keepers' `linear_id:` values.

---

## Configuration

`~/.lebop/config.yaml` is optional — `lebop` works with just auth. Config extends behavior per-repo:

```yaml
default_team: UE                               # used when no per-repo override matches
workspaces:
  UE:
    url_prefix: https://linear.app/unlink-xyz  # needed by L004 (bracket issue refs)

repos:
  /Users/you/dev/some-repo:                    # absolute git-root path
    team: UE                                   # team override for this repo
    conventions:
      bracket_issue_refs: true                 # L004 linter rule
    path_rewrites:                             # R001 linter rule
      - { from: "crates/", to: "protocol/backend/crates/" }
    required_formats:                          # R002 linter rule — regex-based
      - { pattern: '\bpr-(\d+)\b', suggest: '[#$1]', message: "Use [#N] form" }
```

Team metadata is cached at `~/.lebop/cache/<hash>/_team/<TEAM>.yaml` with a 1h TTL; auto-refreshes on name-resolution misses (e.g., a project you just created).

---

## Claude Code integration

lebop ships a user-level **skill** plus three **slash commands** that teach Claude Code agents when and how to use the tool:

| File | Role |
|---|---|
| `claude/skills/lebop/SKILL.md` | Invocation guide: verb-selection table, pull→edit→push loop, plan workflow, team-collaboration hazard, Linear quirks |
| `claude/commands/lebop-pull.md` | `/lebop-pull` slash command |
| `claude/commands/lebop-push.md` | `/lebop-push` slash command |
| `claude/commands/lebop-lint.md` | `/lebop-lint` slash command |

Install via symlinks (so `git pull` stays in sync with no re-install):

```sh
./bin/install-claude
```

Restart Claude Code or open a new session to pick up the skill.

---

## Install details (PATH)

`bun link` places the binary at `~/.bun/bin/lebop`, which is only on the PATH of interactive shells — **not** subprocesses spawned by agents like Claude Code. Two options:

**Option A — symlink into a universally-on-PATH directory (recommended):**
```sh
ln -sf "$HOME/.bun/bin/lebop" /opt/homebrew/bin/lebop   # macOS w/ Homebrew
# or on Linux:
# sudo ln -sf "$HOME/.bun/bin/lebop" /usr/local/bin/lebop
```

**Option B — shell-PATH only (interactive terminals only):**
```sh
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zprofile
# then restart your shell and any agent parent processes
```

Option A is required if you want agents started BEFORE you edited your shell config to find `lebop`.

---

## Why not just `@schpet/linear-cli` or Linear's MCP?

**Best for agents, sufficient for humans.** lebop is built around the agent use case (bulk markdown editing, declarative `plan apply`, renderer-aware lint, CAS-protected push, MCP server). It deliberately skips interactive ergonomics that `@schpet/linear-cli` does well — `issue start` (state + branch), `pr` (gh-cli wrapper), browser-open shortcuts, jj/git issue inference.

| | `@schpet/linear-cli` | Linear MCP server | `lebop` |
|---|---|---|---|
| Shape | Interactive CLI | Hosted MCP | Agentic CLI **and** MCP, bulk + declarative |
| Round-trip | Per-command | Per-tool-call | Pull-edit-push, plan-diff-pull |
| Mutation batching | Sequential | Sequential | One call per plan or one multi-alias push |
| CAS / staleness | None | None | `updatedAt` check; `--force` to bypass |
| Markdown lint | None | None | 8 rules + repo-scoped config |
| Declarative planning | Not a goal | Not exposed | Hero feature |
| GraphQL escape hatch | Yes | No | Yes (`raw`) |
| Local cache | No | No | Yes (`~/.lebop/cache/`) |
| `issue start` / branch / `pr` | Yes | No | **Deliberately skipped** — pair with `linear-cli` |

**For agent-driven work**, lebop replaces both `linear-cli` and the Linear MCP. **For solo human work**, pair lebop (bulk + plan + agent + CAS) with `linear-cli` (interactive single-issue flows).

See [`docs/spec.md`](docs/spec.md) for the full motivation, design decisions, command reference, plan workflow, lint rule catalog, Linear API facts, discovered quirks, and roadmap to public release.

---

## Documentation

- [`docs/spec.md`](docs/spec.md) — single source of truth: architecture, setup, full CLI reference, plan workflow, lint rules, Linear API facts, discovered quirks, v1.0 roadmap.

---

## License

TBD — license decision pending. Tracked in the v1.0 OSS-readiness work (see `docs/spec.md` §13.4).
