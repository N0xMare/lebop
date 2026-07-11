/**
 * lebop's MCP server. Exposes lib functions as MCP tools so non-CLI agents
 * (Cursor, Claude Desktop, Windsurf, IDE extensions) can drive Linear with
 * the same retry/stale-guard/lint guarantees the CLI provides.
 *
 * Auth: bearer-token via the existing `~/.lebop/auth.json` (multi-workspace).
 * Tool calls accept an optional `workspace` arg to target a specific
 * workspace; falls back to LEBOP_WORKSPACE env or the auth file's default.
 *
 * Transport: stdio. Right shape for binary distribution; HTTP+SSE comes in
 * a follow-up release.
 *
 * Tool bodies live in `./tools/*`; this module is boot + wiring only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { refreshCachedProjectAfterUpdate } from "../lib/cacheRefresh.ts";
import { resolveConfig } from "../lib/config.ts";
import { getTeam } from "../lib/teams.ts";
import { LEBOP_VERSION } from "../lib/version.ts";
import {
  requireConfirm,
  requireMcpEntity,
  resolveMcpRepoCacheContext,
  resolveTeamSelectorToId,
  WORKSPACE_PARAM_DESCRIPTION,
} from "./common.ts";
import { installEnvelopeValidator } from "./envelopeValidator.ts";
import { registerAllMcpTools } from "./tools/index.ts";
import type { McpServerLike, RegisteredMcpToolDefinition } from "./types.ts";

export { formatToolError } from "./response.ts";

// Both the CLI/lib update path and MCP `update_issue` share the same milestone
// and cycle resolvers from ../lib/resolve.ts. The cycle resolver requires
// `teamKey` because cycle names are not unique across teams.

export function collectMcpToolDefinitions(): RegisteredMcpToolDefinition[] {
  const definitions: RegisteredMcpToolDefinition[] = [];
  const collector = {
    registerTool(
      name: string,
      config: RegisteredMcpToolDefinition["config"],
      handler: unknown,
    ): void {
      definitions.push({ name, config, handler });
    },
  };
  registerTools(collector);
  return definitions;
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "lebop",
    version: LEBOP_VERSION,
  });

  registerTools(server);
  installEnvelopeValidator(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // server.connect resolves when the transport closes; we just await it
  // implicitly by returning. Stay alive until stdin EOF / parent exit.
}

/** Register the MCP tools exposed through the stdio server. */
function registerTools(server: McpServerLike): void {
  const workspaceParamDescription = WORKSPACE_PARAM_DESCRIPTION;
  const sharedConfirmEntity = {
    workspaceParamDescription,
    requireConfirm,
    requireMcpEntity,
  };

  registerAllMcpTools(server, {
    workspace: { workspaceParamDescription },
    issues: {
      workspaceParamDescription,
      resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
      getTeam: async (team) => getTeam(team),
      resolveConfig: async (options) => resolveConfig(options),
      resolveCacheContext: resolveMcpRepoCacheContext,
      requireConfirm,
      requireMcpEntity,
    },
    projects: {
      workspaceParamDescription,
      requireConfirm,
      resolveMcpRepoCacheContext,
      resolveTeamSelectorToId,
      resolveDefaultTeamKey: async () => (await resolveConfig()).team,
      resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
      refreshCachedProjectAfterUpdate,
    },
    pull: {
      workspaceParamDescription,
      requireConfirm,
    },
    publish: {
      workspaceParamDescription,
    },
    relations: sharedConfirmEntity,
    labels: {
      workspaceParamDescription,
      requireConfirm,
    },
    milestones: sharedConfirmEntity,
    projectUpdates: { workspaceParamDescription },
    initiatives: sharedConfirmEntity,
    initiativeUpdates: { workspaceParamDescription },
    cycles: {
      workspaceParamDescription,
      requireMcpEntity,
    },
    documents: sharedConfirmEntity,
    agentSessions: {
      workspaceParamDescription,
      requireMcpEntity,
    },
    teams: {
      workspaceParamDescription,
      requireMcpEntity,
    },
    lint: { workspaceParamDescription },
    comments: {
      workspaceParamDescription,
      requireConfirm,
    },
    cache: {
      workspaceParamDescription,
      requireConfirm,
    },
    plan: {
      workspaceParamDescription,
      requireConfirm,
    },
    link: { workspaceParamDescription },
    raw: {
      workspaceParamDescription,
      requireConfirm,
    },
    auth: { workspaceParamDescription },
    attachments: {
      workspaceParamDescription,
      requireConfirm,
    },
    lookups: { workspaceParamDescription },
  });
}
