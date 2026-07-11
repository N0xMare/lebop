import { envelope } from "../../lib/envelope.ts";
import {
  buildProjectUpdateCreateInputFromMcp,
  buildProjectUpdateCreateMcpInputSchema,
  buildProjectUpdateListInputFromMcp,
  buildProjectUpdateListMcpInputSchema,
  executeProjectUpdateCreate,
  executeProjectUpdateList,
  type ProjectUpdateCreateMcpInput,
  type ProjectUpdateListMcpInput,
  projectUpdateCreateOperation,
  projectUpdateListOperation,
  projectUpdateListPayload,
} from "../../surface/project-updates.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface ProjectUpdateToolDeps {
  workspaceParamDescription: string;
}

export function buildProjectUpdateToolSpecs(deps: ProjectUpdateToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_project_updates",
      config: mcpToolConfig(
        projectUpdateListOperation,
        buildProjectUpdateListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ProjectUpdateListMcpInput) => {
        const result = await executeProjectUpdateList(buildProjectUpdateListInputFromMcp(args));
        return text(envelope(projectUpdateListPayload(result)));
      },
    },
    {
      name: "create_project_update",
      config: mcpToolConfig(
        projectUpdateCreateOperation,
        buildProjectUpdateCreateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ProjectUpdateCreateMcpInput) => {
        const result = await executeProjectUpdateCreate(buildProjectUpdateCreateInputFromMcp(args));
        return text(envelope({ project_update: result.project_update }));
      },
    },
  ];
}
