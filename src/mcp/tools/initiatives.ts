import { envelope } from "../../lib/envelope.ts";
import {
  buildInitiativeAddProjectInputFromMcp,
  buildInitiativeAddProjectMcpInputSchema,
  buildInitiativeArchiveInputFromMcp,
  buildInitiativeArchiveMcpInputSchema,
  buildInitiativeCreateInputFromMcp,
  buildInitiativeCreateMcpInputSchema,
  buildInitiativeDeleteInputFromMcp,
  buildInitiativeDeleteMcpInputSchema,
  buildInitiativeGetInput,
  buildInitiativeGetMcpInputSchema,
  buildInitiativeListInputFromMcp,
  buildInitiativeListMcpInputSchema,
  buildInitiativeRemoveProjectInputFromMcp,
  buildInitiativeRemoveProjectMcpInputSchema,
  buildInitiativeUnarchiveInput,
  buildInitiativeUnarchiveMcpInputSchema,
  buildInitiativeUpdateInputFromMcp,
  buildInitiativeUpdateMcpInputSchema,
  executeInitiativeAddProject,
  executeInitiativeArchive,
  executeInitiativeCreate,
  executeInitiativeDelete,
  executeInitiativeGet,
  executeInitiativeList,
  executeInitiativeRemoveProject,
  executeInitiativeUnarchive,
  executeInitiativeUpdate,
  INITIATIVE_MCP_GET_HINT,
  INITIATIVE_MCP_UPDATE_HINT,
  type InitiativeAddProjectMcpInput,
  type InitiativeArchiveMcpInput,
  type InitiativeCreateMcpInput,
  type InitiativeDeleteMcpInput,
  type InitiativeListMcpInput,
  type InitiativeRemoveProjectMcpInput,
  type InitiativeUpdateMcpInput,
  initiativeAddProjectOperation,
  initiativeArchiveOperation,
  initiativeCreateOperation,
  initiativeDeleteMcpSuccess,
  initiativeDeleteOperation,
  initiativeDeletePayload,
  initiativeGetOperation,
  initiativeListOperation,
  initiativeListPayload,
  initiativeRemoveProjectOperation,
  initiativeUnarchiveOperation,
  initiativeUpdateOperation,
} from "../../surface/initiatives.ts";
import { text } from "../response.ts";
import type { McpToolSpec, ToolHandlerArgs } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface InitiativeToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
  /** Kept for server wiring compatibility; get path throws via surface execute. */
  requireMcpEntity: <T>(value: T | null | undefined, label: string, id: string, hint?: string) => T;
}

export function buildInitiativeToolSpecs(deps: InitiativeToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_initiatives",
      config: mcpToolConfig(
        initiativeListOperation,
        buildInitiativeListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeListMcpInput) => {
        const result = await executeInitiativeList(buildInitiativeListInputFromMcp(args));
        return text(envelope(initiativeListPayload(result)));
      },
    },
    {
      name: "get_initiative",
      config: mcpToolConfig(
        initiativeGetOperation,
        buildInitiativeGetMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ToolHandlerArgs) => {
        const initiative = await executeInitiativeGet(
          buildInitiativeGetInput(args.id as string),
          INITIATIVE_MCP_GET_HINT,
        );
        return text(envelope({ initiative }));
      },
    },
    {
      name: "create_initiative",
      config: mcpToolConfig(
        initiativeCreateOperation,
        buildInitiativeCreateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeCreateMcpInput) => {
        const initiative = await executeInitiativeCreate(buildInitiativeCreateInputFromMcp(args));
        return text(envelope({ initiative }));
      },
    },
    {
      name: "update_initiative",
      config: mcpToolConfig(
        initiativeUpdateOperation,
        buildInitiativeUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeUpdateMcpInput) => {
        const initiative = await executeInitiativeUpdate(
          buildInitiativeUpdateInputFromMcp(args),
          INITIATIVE_MCP_UPDATE_HINT,
        );
        return text(envelope({ initiative }));
      },
    },
    {
      name: "archive_initiative",
      config: mcpToolConfig(
        initiativeArchiveOperation,
        buildInitiativeArchiveMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeArchiveMcpInput) => {
        deps.requireConfirm(args, "archive_initiative");
        const result = await executeInitiativeArchive(buildInitiativeArchiveInputFromMcp(args));
        return text(envelope({ id: result.id, success: result.success }));
      },
    },
    {
      name: "unarchive_initiative",
      config: mcpToolConfig(
        initiativeUnarchiveOperation,
        buildInitiativeUnarchiveMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ToolHandlerArgs) => {
        const result = await executeInitiativeUnarchive(
          buildInitiativeUnarchiveInput(args.id as string),
        );
        return text(envelope({ id: result.id, success: result.success }));
      },
    },
    {
      name: "delete_initiative",
      config: mcpToolConfig(
        initiativeDeleteOperation,
        buildInitiativeDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeDeleteMcpInput) => {
        deps.requireConfirm(args, "delete_initiative");
        const result = await executeInitiativeDelete(buildInitiativeDeleteInputFromMcp(args));
        return text(envelope(initiativeDeletePayload(result, initiativeDeleteMcpSuccess(result))));
      },
    },
    {
      name: "initiative_add_project",
      config: mcpToolConfig(
        initiativeAddProjectOperation,
        buildInitiativeAddProjectMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeAddProjectMcpInput) => {
        const result = await executeInitiativeAddProject(
          buildInitiativeAddProjectInputFromMcp(args),
        );
        return text(envelope({ edge_id: result.edge_id }));
      },
    },
    {
      name: "initiative_remove_project",
      config: mcpToolConfig(
        initiativeRemoveProjectOperation,
        buildInitiativeRemoveProjectMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeRemoveProjectMcpInput) => {
        deps.requireConfirm(args, "initiative_remove_project");
        const result = await executeInitiativeRemoveProject(
          buildInitiativeRemoveProjectInputFromMcp(args),
        );
        return text(envelope({ ...result }));
      },
    },
  ];
}
