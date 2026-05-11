# Agent integrations for lebop

This directory contains agent-facing assets — skill content + slash-command
prompts — describing how an autonomous coding agent should use `lebop` to
operate inside Linear. The content is plain markdown; each agent platform
loads it from a different path, but the content itself is portable.

## Layout

```
agents/
├── skills/lebop/SKILL.md         # the main "how an agent uses lebop" guide
└── commands/                     # individual prompts for common workflows
    ├── lebop-pull.md             # pull → edit → push loop
    ├── lebop-push.md             # CAS-protected push
    └── lebop-lint.md             # markdown lint pre-mutation
```

`skills/lebop/SKILL.md` carries Claude Code-style frontmatter (`name`,
`description`) at the top. Most agent platforms either consume that
frontmatter natively or treat it as a comment block — either way the body
is plain markdown that any agent can ingest.

## Per-agent installation

### Claude Code

Run the bundled installer once; it symlinks `agents/skills/lebop/SKILL.md`
into `~/.claude/skills/lebop/SKILL.md` and each `agents/commands/*.md` into
`~/.claude/commands/`:

```sh
./bin/install-claude
```

Symlinks resolve through the repo, so `git pull` keeps everything current
with no re-install.

### Other agents

Point your agent at the files in this directory using whatever mechanism
it supports (rules, prompts, custom instructions, etc.). The exact path
will depend on the platform; the content is the same.

If you wire up a one-shot installer for another agent, drop a script
alongside `bin/install-claude` and PR it.
