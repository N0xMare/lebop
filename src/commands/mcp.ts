import type { Command } from "commander";
import { startMcpServer } from "../mcp/server.ts";

/**
 * `lebop mcp` — start the MCP server over stdio. Designed to be spawned by
 * MCP-aware hosts (Cursor, Claude Desktop, Windsurf, IDE extensions).
 * Speaks JSON-RPC over stdin/stdout per the MCP spec; logs go to stderr
 * (chalk-free for cleanliness in host log panels).
 *
 * Auth: uses `~/.lebop/auth.json` (multi-workspace, schema v2). Per-tool
 * `workspace` arg overrides the default; otherwise LEBOP_WORKSPACE env or
 * the auth file's default applies.
 */
export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("start the lebop MCP server (stdio transport)")
    .action(async () => {
      // No human-friendly stdout here — the protocol owns stdout. Errors
      // surface to stderr through cli.ts's top-level handler if startup
      // fails before the transport takes over.
      await startMcpServer();
    });
}
