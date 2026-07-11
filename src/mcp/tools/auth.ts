import { envelope } from "../../lib/envelope.ts";
import {
  buildListWorkspacesInputFromMcp,
  buildListWorkspacesMcpInputSchema,
  buildRefreshWhoamiInputFromMcp,
  buildRefreshWhoamiMcpInputSchema,
  buildSetDefaultWorkspaceInputFromMcp,
  buildSetDefaultWorkspaceMcpInputSchema,
  buildSetWorkspaceDefaultTeamInputFromMcp,
  buildSetWorkspaceDefaultTeamMcpInputSchema,
  buildWhoamiInputFromMcp,
  buildWhoamiMcpInputSchema,
  executeListWorkspaces,
  executeRefreshWhoami,
  executeSetDefaultWorkspace,
  executeSetWorkspaceDefaultTeam,
  executeWhoami,
  listWorkspacesOperation,
  listWorkspacesPayload,
  type RefreshWhoamiMcpInput,
  refreshWhoamiOperation,
  type SetDefaultWorkspaceMcpInput,
  type SetWorkspaceDefaultTeamMcpInput,
  setDefaultWorkspaceOperation,
  setDefaultWorkspacePayload,
  setWorkspaceDefaultTeamOperation,
  setWorkspaceDefaultTeamPayload,
  type WhoamiMcpInput,
  whoamiOperation,
  whoamiPayload,
} from "../../surface/auth.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface AuthToolDeps {
  workspaceParamDescription: string;
}

export function buildAuthToolSpecs(deps: AuthToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_workspaces",
      config: mcpToolConfig(listWorkspacesOperation, buildListWorkspacesMcpInputSchema()),
      handler: async () => {
        const result = await executeListWorkspaces(buildListWorkspacesInputFromMcp());
        return text(envelope(listWorkspacesPayload(result)));
      },
    },
    {
      name: "set_default_workspace",
      config: mcpToolConfig(setDefaultWorkspaceOperation, buildSetDefaultWorkspaceMcpInputSchema()),
      handler: async (args: SetDefaultWorkspaceMcpInput) => {
        const result = await executeSetDefaultWorkspace(buildSetDefaultWorkspaceInputFromMcp(args));
        return text(envelope(setDefaultWorkspacePayload(result)));
      },
    },
    {
      name: "whoami",
      config: mcpToolConfig(
        whoamiOperation,
        buildWhoamiMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: WhoamiMcpInput) => {
        const result = await executeWhoami(buildWhoamiInputFromMcp(args));
        return text(envelope(whoamiPayload(result)));
      },
    },
    {
      name: "refresh_whoami",
      config: mcpToolConfig(
        refreshWhoamiOperation,
        buildRefreshWhoamiMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: RefreshWhoamiMcpInput) => {
        const result = await executeRefreshWhoami(buildRefreshWhoamiInputFromMcp(args));
        return text(envelope(whoamiPayload(result)));
      },
    },
    {
      name: "set_workspace_default_team",
      config: mcpToolConfig(
        setWorkspaceDefaultTeamOperation,
        buildSetWorkspaceDefaultTeamMcpInputSchema(),
      ),
      handler: async (args: SetWorkspaceDefaultTeamMcpInput) => {
        const result = await executeSetWorkspaceDefaultTeam(
          buildSetWorkspaceDefaultTeamInputFromMcp(args),
          {
            teamNotFoundHint: `run \`lebop teams --workspace ${args.workspace_slug}\` to list valid keys`,
          },
        );
        return text(envelope(setWorkspaceDefaultTeamPayload(result)));
      },
    },
  ];
}
