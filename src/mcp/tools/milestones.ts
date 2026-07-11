import { envelope } from "../../lib/envelope.ts";
import {
  buildMilestoneCreateInputFromMcp,
  buildMilestoneCreateMcpInputSchema,
  buildMilestoneDeleteInputFromMcp,
  buildMilestoneDeleteMcpInputSchema,
  buildMilestoneGetInput,
  buildMilestoneGetMcpInputSchema,
  buildMilestoneListInputFromMcp,
  buildMilestoneListMcpInputSchema,
  buildMilestoneUpdateInputFromMcp,
  buildMilestoneUpdateMcpInputSchema,
  executeMilestoneCreate,
  executeMilestoneDelete,
  executeMilestoneGet,
  executeMilestoneList,
  executeMilestoneUpdate,
  MILESTONE_MCP_GET_HINT,
  MILESTONE_MCP_PROJECT_NOT_FOUND_HINT,
  type MilestoneCreateMcpInput,
  type MilestoneDeleteMcpInput,
  type MilestoneListMcpInput,
  type MilestoneUpdateMcpInput,
  milestoneCreateOperation,
  milestoneDeleteOperation,
  milestoneGetOperation,
  milestoneListOperation,
  milestoneListPayload,
  milestoneUpdateOperation,
} from "../../surface/milestones.ts";
import { text } from "../response.ts";
import type { McpToolSpec, ToolHandlerArgs } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface MilestoneToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

export function buildMilestoneToolSpecs(deps: MilestoneToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_milestones",
      config: mcpToolConfig(
        milestoneListOperation,
        buildMilestoneListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: MilestoneListMcpInput) => {
        const result = await executeMilestoneList(buildMilestoneListInputFromMcp(args), {
          projectNotFoundHint: MILESTONE_MCP_PROJECT_NOT_FOUND_HINT,
        });
        return text(envelope(milestoneListPayload(result)));
      },
    },
    {
      name: "get_milestone",
      config: mcpToolConfig(
        milestoneGetOperation,
        buildMilestoneGetMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ToolHandlerArgs) => {
        const milestone = await executeMilestoneGet(
          buildMilestoneGetInput(args.id as string),
          MILESTONE_MCP_GET_HINT,
        );
        return text(envelope({ milestone }));
      },
    },
    {
      name: "create_milestone",
      config: mcpToolConfig(
        milestoneCreateOperation,
        buildMilestoneCreateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: MilestoneCreateMcpInput) => {
        const milestone = await executeMilestoneCreate(buildMilestoneCreateInputFromMcp(args));
        return text(envelope({ milestone }));
      },
    },
    {
      name: "update_milestone",
      config: mcpToolConfig(
        milestoneUpdateOperation,
        buildMilestoneUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: MilestoneUpdateMcpInput) => {
        const milestone = await executeMilestoneUpdate(buildMilestoneUpdateInputFromMcp(args), {
          projectNotFoundHint: MILESTONE_MCP_PROJECT_NOT_FOUND_HINT,
        });
        return text(envelope({ milestone }));
      },
    },
    {
      name: "delete_milestone",
      config: mcpToolConfig(
        milestoneDeleteOperation,
        buildMilestoneDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: MilestoneDeleteMcpInput) => {
        deps.requireConfirm(args, "delete_milestone");
        const result = await executeMilestoneDelete(buildMilestoneDeleteInputFromMcp(args));
        return text(envelope({ ...result }));
      },
    },
  ];
}
