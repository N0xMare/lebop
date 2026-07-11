import { envelope } from "../../lib/envelope.ts";
import {
  buildInitiativeUpdateCreateInputFromMcp,
  buildInitiativeUpdateCreateMcpInputSchema,
  buildInitiativeUpdateListInputFromMcp,
  buildInitiativeUpdateListMcpInputSchema,
  executeInitiativeUpdateCreate,
  executeInitiativeUpdateList,
  type InitiativeUpdateCreateMcpInput,
  type InitiativeUpdateListMcpInput,
  initiativeUpdateCreateOperation,
  initiativeUpdateListOperation,
  initiativeUpdateListPayload,
} from "../../surface/initiative-updates.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface InitiativeUpdateToolDeps {
  workspaceParamDescription: string;
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
        return text(envelope(initiativeUpdateListPayload(result)));
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
        return text(envelope({ initiative_update: result.initiative_update }));
      },
    },
  ];
}
