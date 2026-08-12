import type { SurfaceOperationContract } from "./contracts.ts";

/**
 * CLI-only public entrypoints with no MCP dual surface.
 * Declared for L2 inventory derivation (Phase D); commands remain local adapters.
 * L2 derives CLI exception rows from `exception.reason` (mcp / schema / completions).
 */

const mcpStartDescription =
  "Start the lebop MCP server over stdio for MCP-aware hosts (Cursor, Claude Desktop, etc.).";

export const mcpStartOperation = {
  id: "mcp.start",
  domain: "other",
  resource: "mcp",
  action: "other",
  title: "Start MCP server (stdio)",
  description: mcpStartDescription,
  cli: {
    command: "mcp",
    nonLiveReason:
      "The CLI entrypoint starts the MCP transport; live coverage is recorded through the MCP tool matrix and compiled pre-auth MCP handshake instead of a CLI semantic step.",
  },
  // Explicit undefined so SURFACE_OPERATIONS union keeps optional `mcp` for typecheck.
  mcp: undefined,
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
  exception: {
    kind: "cli_only",
    reason: "CLI-only MCP stdio server entrypoint",
  },
  notes:
    "No MCP tool dual: this command *is* the MCP process. Inventory-only surface op; execute stays in commands/mcp.ts → startMcpServer().",
} satisfies SurfaceOperationContract<unknown, unknown>;

const schemaDumpDescription =
  "Dump Linear's GraphQL schema (SDL or raw introspection JSON) to stdout or a file.";

export const schemaDumpOperation = {
  id: "schema.dump",
  domain: "other",
  resource: "schema",
  action: "other",
  title: "Dump Linear GraphQL schema",
  description: schemaDumpDescription,
  cli: {
    command: "schema",
    liveSteps: ["cli:schema --json"],
  },
  mcp: undefined,
  safety: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  exception: {
    kind: "cli_only",
    reason: "CLI-only local GraphQL schema export",
  },
  notes:
    "No MCP dual (agents already speak GraphQL via raw_graphql when needed). Inventory-only; introspection + SDL print stay in commands/schema.ts.",
} satisfies SurfaceOperationContract<unknown, unknown>;

const completionsShellDescription =
  "Emit a shell completion script for bash, zsh, or fish based on the Commander command tree.";

export const completionsShellOperation = {
  id: "completions.shell",
  domain: "other",
  resource: "completions",
  action: "other",
  title: "Emit shell completion script",
  description: completionsShellDescription,
  cli: {
    command: "completions",
    liveSteps: ["cli:completions bash"],
  },
  mcp: undefined,
  safety: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  exception: {
    kind: "cli_only",
    reason: "CLI shell integration",
  },
  notes:
    "Local-only shell integration; requires Commander program tree at registration time. Inventory-only surface op.",
} satisfies SurfaceOperationContract<unknown, unknown>;

/** Agent-first self-update (GitHub releases); no MCP dual. */
export const selfUpdateOperation = {
  id: "meta.update",
  domain: "other",
  resource: "self_update",
  action: "other",
  title: "Self-update lebop binary",
  description: "Check or install a newer lebop release binary from GitHub.",
  cli: {
    command: "update",
    nonLiveReason: "Touches the installed binary and network releases; not Linear surface live.",
  },
  mcp: undefined,
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  exception: {
    kind: "cli_only",
    reason: "CLI-only binary self-update against GitHub releases",
  },
  notes: "Inventory-only; implementation in commands/update.ts + lib/selfUpdate.ts.",
} satisfies SurfaceOperationContract<unknown, unknown>;

/** Dense agent help catalog (Commander help override). */
export const agentHelpOperation = {
  id: "meta.help",
  domain: "other",
  resource: "help",
  action: "other",
  title: "Agent help catalog",
  description: "Dense machine help catalog for lebop commands (agent-first).",
  cli: {
    command: "help",
    nonLiveReason: "Local Commander help; no Linear I/O.",
  },
  mcp: undefined,
  safety: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  exception: {
    kind: "cli_only",
    reason: "CLI-only agent help / discovery catalog",
  },
  notes: "Inventory-only; lib/agentHelp.ts + commands/help.ts.",
} satisfies SurfaceOperationContract<unknown, unknown>;

/**
 * Bare `lebop` home (`commands/home.ts`) is intentionally **not** a Commander
 * leaf and is **not** listed here: default-action control plane, not a dual-surface
 * op. Documented L2 exception — not undeclared inventory.
 */
export const CLI_ONLY_SURFACE_OPERATIONS = [
  mcpStartOperation,
  schemaDumpOperation,
  completionsShellOperation,
  selfUpdateOperation,
  agentHelpOperation,
] as const;
