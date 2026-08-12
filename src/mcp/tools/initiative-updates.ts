import { envelope } from "../../lib/envelope.ts";
import { mcpGetNext } from "../../lib/nextStubs.ts";
import {
  buildInitiativeUpdateCreateInputFromMcp,
  buildInitiativeUpdateCreateMcpInputSchema,
  buildInitiativeUpdateDeleteInputFromMcp,
  buildInitiativeUpdateDeleteMcpInputSchema,
  buildInitiativeUpdateListInputFromMcp,
  buildInitiativeUpdateListMcpInputSchema,
  buildInitiativeUpdateUpdateInputFromMcp,
  buildInitiativeUpdateUpdateMcpInputSchema,
  executeInitiativeUpdateCreate,
  executeInitiativeUpdateDelete,
  executeInitiativeUpdateList,
  executeInitiativeUpdateUpdate,
  type InitiativeUpdateCreateMcpInput,
  type InitiativeUpdateDeleteMcpInput,
  type InitiativeUpdateListMcpInput,
  type InitiativeUpdateUpdateMcpInput,
  initiativeUpdateCreateOperation,
  initiativeUpdateDeleteOperation,
  initiativeUpdateListOperation,
  initiativeUpdateListPayload,
  initiativeUpdateUpdateOperation,
} from "../../surface/initiative-updates.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface InitiativeUpdateToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

export function buildInitiativeUpdateToolSpecs(deps: InitiativeUpdateToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_initiative_updates",
      config: mcpToolConfig(
        initiativeUpdateListOperation,
        buildInitiativeUpdateListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeUpdateListMcpInput) => {
        const result = await executeInitiativeUpdateList(
          buildInitiativeUpdateListInputFromMcp(args),
        );
        return text(
          envelope({
            ...initiativeUpdateListPayload(result),
            next: mcpGetNext("get_initiative", "create_initiative_update"),
          }),
        );
      },
    },
    {
      name: "create_initiative_update",
      config: mcpToolConfig(
        initiativeUpdateCreateOperation,
        buildInitiativeUpdateCreateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeUpdateCreateMcpInput) => {
        const result = await executeInitiativeUpdateCreate(
          buildInitiativeUpdateCreateInputFromMcp(args),
        );
        return text(
          envelope({
            initiative_update: result.initiative_update,
            next: mcpGetNext("list_initiative_updates", "get_initiative"),
          }),
        );
      },
    },
    {
      name: "update_initiative_update",
      config: mcpToolConfig(
        initiativeUpdateUpdateOperation,
        buildInitiativeUpdateUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeUpdateUpdateMcpInput) => {
        const initiative_update = await executeInitiativeUpdateUpdate(
          buildInitiativeUpdateUpdateInputFromMcp(args),
        );
        return text(
          envelope({
            initiative_update,
            next: mcpGetNext("list_initiative_updates", "get_initiative"),
          }),
        );
      },
    },
    {
      name: "soft_delete_initiative_update",
      config: mcpToolConfig(
        initiativeUpdateDeleteOperation,
        buildInitiativeUpdateDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: InitiativeUpdateDeleteMcpInput) => {
        deps.requireConfirm(args, "soft_delete_initiative_update");
        const result = await executeInitiativeUpdateDelete(
          buildInitiativeUpdateDeleteInputFromMcp(args),
        );
        return text(envelope({ ...result, next: mcpGetNext("list_initiative_updates") }));
      },
    },
  ];
}
