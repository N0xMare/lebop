import { envelope } from "../../lib/envelope.ts";
import { collectLinearRateLimitTelemetry, linearApiEnvelopeMeta } from "../../lib/rateLimit.ts";
import {
  buildExploreWorkspaceInputFromMcp,
  buildExploreWorkspaceMcpInputSchema,
  buildFetchWorkspaceInputFromMcp,
  buildFetchWorkspaceMcpInputSchema,
  executeExploreWorkspace,
  executeFetchWorkspace,
  exploreWorkspaceOperation,
  fetchWorkspaceOperation,
  type WorkspaceExploreMcpInput,
  type WorkspaceFetchMcpInput,
} from "../../surface/workspace.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface WorkspaceToolDeps {
  workspaceParamDescription: string;
}

export function buildWorkspaceToolSpecs(deps: WorkspaceToolDeps): McpToolSpec[] {
  return [
    {
      name: "explore_linear_workspace",
      config: mcpToolConfig(
        exploreWorkspaceOperation,
        buildExploreWorkspaceMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: WorkspaceExploreMcpInput) => {
        const input = buildExploreWorkspaceInputFromMcp(args);
        const { value, telemetry } = await collectLinearRateLimitTelemetry(() =>
          executeExploreWorkspace(input),
        );
        return text(envelope({ ...value }, linearApiEnvelopeMeta(telemetry)));
      },
    },
    {
      name: "fetch_linear_workspace",
      config: mcpToolConfig(
        fetchWorkspaceOperation,
        buildFetchWorkspaceMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: WorkspaceFetchMcpInput) => {
        const input = buildFetchWorkspaceInputFromMcp(args);
        const { value, telemetry } = await collectLinearRateLimitTelemetry(() =>
          executeFetchWorkspace(input),
        );
        return text(envelope({ ...value }, linearApiEnvelopeMeta(telemetry)));
      },
    },
  ];
}
