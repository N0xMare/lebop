# leebop

Agentic Linear CLI. Pull → edit → push loop for bulk changes, plus single-shot verbs (`comment`, `set`), discovery (`list`, `projects`, `teams`), and a GraphQL escape hatch (`raw`). Designed so coding agents can drive Linear as efficiently as they drive their filesystem.

Think: git, for Linear.

## Install

### Prerequisites

- [Bun](https://bun.sh) `>= 1.1` — `curl -fsSL https://bun.sh/install | bash`
- A Linear personal API key (create at **Settings → API** in Linear)

### From this repo

```sh
git clone git@github.com:N0xMare/leebop.git
cd leebop
bun install
bun link    # registers `leebop` under Bun's global bin (~/.bun/bin)
```

### Make `leebop` discoverable on PATH

`bun link` puts the binary in `~/.bun/bin`, which may not be on your shell's PATH (and, crucially, isn't on the PATH inherited by subprocesses spawned by tools like Claude Code). Two options:

**Option A — shell PATH (interactive terminals only):**
```sh
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zprofile   # or ~/.bashrc / ~/.profile
```
Then restart the shell (and any parent tools, e.g. Claude Code, so they inherit the new PATH).

**Option B — symlink into a system-wide PATH dir (recommended for agent use):**
```sh
ln -sf "$HOME/.bun/bin/leebop" /opt/homebrew/bin/leebop   # macOS w/ Homebrew
# or on Linux:
# sudo ln -sf "$HOME/.bun/bin/leebop" /usr/local/bin/leebop
```
This makes `leebop` immediately visible to any process whose PATH already includes `/opt/homebrew/bin` or `/usr/local/bin` — which is basically everything, including agents started before you edited your shell config.

### Authenticate

```sh
leebop auth login                # paste a PAK interactively (input hidden)
# or
leebop auth login --from-schpet  # import from @schpet/linear-cli if installed
# or
leebop auth login --token-file ./my-pak.txt
```

Credentials land at `~/.leebop/auth.json` (mode 0600).

### Wire up Claude Code integration (skill + slash commands)

leebop ships its agent-facing assets — `SKILL.md` plus three slash commands (`/leebop-pull`, `/leebop-push`, `/leebop-lint`) — under `claude/` in this repo. Run the installer once to symlink them into `~/.claude/`:

```sh
./bin/install-claude
```

The script creates symlinks (not copies), so any update to `claude/skills/leebop/SKILL.md` or `claude/commands/leebop-*.md` in this repo is picked up by Claude Code immediately on the next session — no re-install after `git pull`. Restart Claude Code (or open a new session) the first time to load the skill into the matcher.

## How production CLIs handle install/PATH

leebop's install story (`bun link` + explicit symlink or PATH edit) is deliberately minimal for a personal tool. For reference, here's how the ecosystem solves "make this binary discoverable everywhere" at different scales:

| Pattern | Examples | How it works | Trade-offs |
|---|---|---|---|
| **Language package manager, global install** | `npm install -g <pkg>`, `pnpm add -g`, `cargo install`, `go install` | Each package manager owns a global bin dir that its installer added to PATH. Binary symlinks into that dir. | Zero config if user already uses the PM. Fails when the global bin dir isn't on subprocess PATH (exact issue we hit). |
| **Homebrew formula / tap** | `brew install linear` (@schpet/linear-cli), `brew install gh`, `brew install ripgrep` | Formula managed centrally (homebrew-core) or via a user's tap. `brew link` creates the symlink into `/opt/homebrew/bin` (which is definitively on PATH). | Best UX on macOS. Requires maintaining a formula + versioning. Homebrew's own `/opt/homebrew/bin` is universally on PATH, so subprocess discoverability is free. |
| **Install script** | `curl -fsSL bun.sh/install \| bash`, rustup, nvm, Deno, pnpm, fnm | Script downloads the right binary for the host arch, places it in `$HOME/.local/bin` or similar, edits shell rc files to add to PATH. | Full control over install UX. Can prompt, detect shell, offer both system-wide and user-only modes. Not self-updating unless script does it. |
| **Standalone single-binary release** | Most Go/Rust CLIs on GitHub Releases | User downloads, `chmod +x`, moves to a PATH dir themselves. Often paired with an install script. | Simplest for maintainers. Requires users to know what PATH is. |
| **Platform package managers** | `apt install`, `dnf install`, `winget install`, `scoop install` | Distro/platform-managed. Lands in conventional system PATH locations. | Best UX when available. High maintenance overhead for maintainers (packaging per-distro). |

### What leebop does today

Today's install = `bun link` + manual symlink (Option B above). It's the minimum viable install for a personal tool that's not yet distributed via Homebrew or a script.

### What leebop could do next

In rough order of effort:

1. **Install script** (`curl -fsSL .../install.sh | bash`): detects bun, runs `bun install`/`bun link`, creates the `/opt/homebrew/bin` or `/usr/local/bin` symlink, optionally edits shell rc. ~50 lines of bash. Covers the "one-liner" use case.
2. **Homebrew tap** (`brew tap cmace/leebop && brew install leebop`): requires a formula repo and tagged releases. Best UX on macOS. Moderate maintenance.
3. **`bun install -g` via npm registry**: publishing to npm would let users `bun install -g leebop`. Easy, but relies on Bun (or npm) global-bin-on-PATH — which was the problem for us.
4. **Single-binary release via `bun build --compile`**: ship a native executable per arch. Removes the Bun runtime dependency. Useful if leebop ever needs to run in environments where Bun isn't installed.

Deferred until there's a second user.

## Usage

```sh
# discovery
leebop teams
leebop projects [--team KEY] [--state STATE]
leebop list --assignee me --state-type started --limit 20

# read a single issue inline (no cache write)
leebop show UE-321

# bulk pull → edit → push
leebop pull UE-321..UE-329                    # range
leebop pull --project "Relay Worker Refactor" # project + children
leebop pull UE-321 --to ./work/                # export to a custom dir
# ... edit the markdown files under ~/.leebop/cache/<hash>/issues/... ...
leebop status                                  # see what's modified
leebop push --dry-run                          # preview mutations
leebop push                                    # apply

# single-shot edits (no cache round-trip)
leebop comment UE-321 --body "LGTM"
leebop set state UE-321 "In Progress"
leebop set priority UE-321 urgent
leebop set labels UE-321 +urgent -area:backend      # delta syntax
leebop set assignee UE-321 @me

# GraphQL escape hatch — anything leebop doesn't wrap directly
leebop raw 'query { viewer { id email } }'
echo '{"id":"UE-321"}' | leebop raw 'query($id:String!){issue(id:$id){title}}' --variables-json -

# declarative: author a project + issues + links as a dir of markdown files,
# then realize the whole graph in Linear in one pass
leebop plan validate path/to/plan-dir
leebop plan apply    path/to/plan-dir --dry-run        # preview
leebop plan apply    path/to/plan-dir                  # create / update idempotently
leebop plan diff     path/to/plan-dir                  # local-vs-remote drift (incl. relations)
leebop plan pull     path/to/plan-dir --include-new    # overwrite local with remote; import orphans

# single-issue diff vs live remote (like git diff)
leebop diff UE-321
```

See `leebop <command> --help` for per-verb details, and `docs/plan-spec.md` for the plan format + apply semantics.

## Why not just use `@schpet/linear-cli`?

leebop and `@schpet/linear-cli` are complementary:

- **Single-issue interactive use** — `@schpet/linear-cli` is great. Keep using it.
- **Bulk / agentic use** — leebop. Batched reads, local edit, CAS-protected push, markdown-quirk linting (Phase 3), typed GraphQL escape hatch.

See `docs/spec.md` for the full motivation, design decisions, and alternatives considered (local daemon, MCP server, webhook sync — all rejected for personal-scale use with reasoning).

## Design docs

- [`docs/spec.md`](docs/spec.md) — stable design
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — living phase tracker

## License

Personal tool, no license yet.
