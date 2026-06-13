import { envelope } from "../../lib/envelope.ts";
import {
  buildPullIssuesInputFromMcp,
  buildPullIssuesMcpInputSchema,
  buildPullProjectInputFromMcp,
  buildPullProjectMcpInputSchema,
  executePullIssues,
  executePullProject,
  type PullIssuesMcpInput,
  type PullProjectMcpInput,
  pullIssuesOperation,
  pullProjectOperation,
} from "../../surface/pull.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface PullToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

export function buildPullToolSpecs(deps: PullToolDeps): McpToolSpec[] {
  return [
    {
      name: "pull_issues",
      config: mcpToolConfig(
        pullIssuesOperation,
        buildPullIssuesMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: PullIssuesMcpInput) => {
        if (args.refresh === true) deps.requireConfirm(args, "pull_issues refresh");
        return text(envelope({ ...(await executePullIssues(buildPullIssuesInputFromMcp(args))) }));
      },
    },
    {
      name: "pull_project",
      config: mcpToolConfig(
        pullProjectOperation,
        buildPullProjectMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: PullProjectMcpInput) => {
        if (args.refresh === true) deps.requireConfirm(args, "pull_project refresh");
        return text(
          envelope({ ...(await executePullProject(buildPullProjectInputFromMcp(args))) }),
        );
      },
    },
  ];
}
