# Agent integrations for lebop

Agent-facing assets: **skills** (complete vertical playbooks) and **slash commands**
(thin CLI entry points). Plain markdown — portable across agent platforms.

## Layout

```
agents/
├── skills/
│   ├── cli/                          # shell + lebop CLI only
│   │   ├── lebop/SKILL.md            # install name: lebop-cli
│   │   ├── lebop-program/SKILL.md    # install name: lebop-cli-program
│   │   └── lebop-execution/SKILL.md  # install name: lebop-cli-execution
│   └── mcp/                          # lebop MCP tools only
│       ├── lebop/SKILL.md            # install name: lebop-mcp
│       ├── lebop-program/SKILL.md    # install name: lebop-mcp-program
│       └── lebop-execution/SKILL.md  # install name: lebop-mcp-execution
└── commands/                         # CLI slash entry points
    ├── lebop-research.md
    ├── lebop-pull.md
    ├── lebop-push.md
    ├── lebop-publish.md
    └── lebop-lint.md
```

## Six skills (medium × role)

| Install name | Medium | Role |
|--------------|--------|------|
| `lebop-cli` | CLI | Monolith control plane |
| `lebop-cli-program` | CLI | Program: research → plan → initiative compose → updates |
| `lebop-cli-execution` | CLI | Day-loop: mine/set/pull/push |
| `lebop-mcp` | MCP | Monolith control plane |
| `lebop-mcp-program` | MCP | Program via tools (prefer full profile) |
| `lebop-mcp-execution` | MCP | Day-loop via tools (core often enough) |

**Rules:**

- Each `SKILL.md` is **self-contained** (no `references/`, no cross-skill links).
- **CLI** skills teach shell `lebop …` only.
- **MCP** skills teach tool names / profiles only.
- Boundary: can run shell + `lebop` → CLI skills; host has only MCP tools → MCP skills.

Frontmatter `name:` matches the install name. Bodies are plain markdown.

## Per-agent installation

### Claude Code

From a source or package checkout that remains on disk:

```sh
./bin/install-claude
```

Symlinks each skill directory into `~/.claude/skills/<install-name>/` and each
`agents/commands/lebop-*.md` into `~/.claude/commands/`. Re-run after `git pull`.

The release binary installer does **not** install these assets. CLI and MCP work
without them; install assets when you want skills / slash commands.

### Other agents

Point the host at the relevant `SKILL.md` files. Load **one** skill for the
medium + role of the task (do not stack all six by default).

MCP host example:

```json
{
  "mcpServers": {
    "lebop": {
      "command": "/Users/you/.local/bin/lebop",
      "args": ["mcp"],
      "env": {
        "LEBOP_WORKSPACE": "your-org-url-key"
      }
    }
  }
}
```

Use `"args": ["mcp", "--profile", "full"]` when program/PM tools are required.
Pin `LEBOP_WORKSPACE` so multi-workspace agents hit the intended org.
