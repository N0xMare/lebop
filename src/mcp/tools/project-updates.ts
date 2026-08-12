import { envelope } from "../../lib/envelope.ts";
import { mcpGetNext } from "../../lib/nextStubs.ts";
import {
  buildProjectUpdateCreateInputFromMcp,
  buildProjectUpdateCreateMcpInputSchema,
  buildProjectUpdateDeleteInputFromMcp,
  buildProjectUpdateDeleteMcpInputSchema,
  buildProjectUpdateListInputFromMcp,
  buildProjectUpdateListMcpInputSchema,
  buildProjectUpdateUpdateInputFromMcp,
  buildProjectUpdateUpdateMcpInputSchema,
  executeProjectUpdateCreate,
  executeProjectUpdateDelete,
  executeProjectUpdateList,
  executeProjectUpdateUpdate,
  type ProjectUpdateCreateMcpInput,
  type ProjectUpdateDeleteMcpInput,
  type ProjectUpdateListMcpInput,
  type ProjectUpdateUpdateMcpInput,
  projectUpdateCreateOperation,
  projectUpdateDeleteOperation,
  projectUpdateListOperation,
  projectUpdateListPayload,
  projectUpdateUpdateOperation,
} from "../../surface/project-updates.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface ProjectUpdateToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
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
        return text(
          envelope({
            ...projectUpdateListPayload(result),
            next: mcpGetNext("get_project", "create_project_update"),
          }),
        );
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
        return text(
          envelope({
            project_update: result.project_update,
            next: mcpGetNext("list_project_updates", "get_project"),
          }),
        );
      },
    },
    {
      name: "update_project_update",
      config: mcpToolConfig(
        projectUpdateUpdateOperation,
        buildProjectUpdateUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ProjectUpdateUpdateMcpInput) => {
        const project_update = await executeProjectUpdateUpdate(
          buildProjectUpdateUpdateInputFromMcp(args),
        );
        return text(
          envelope({
            project_update,
            next: mcpGetNext("list_project_updates", "get_project"),
          }),
        );
      },
    },
    {
      name: "soft_delete_project_update",
      config: mcpToolConfig(
        projectUpdateDeleteOperation,
        buildProjectUpdateDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ProjectUpdateDeleteMcpInput) => {
        deps.requireConfirm(args, "soft_delete_project_update");
        const result = await executeProjectUpdateDelete(buildProjectUpdateDeleteInputFromMcp(args));
        return text(envelope({ ...result, next: mcpGetNext("list_project_updates") }));
      },
    },
  ];
}
