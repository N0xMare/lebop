import { envelope } from "../../lib/envelope.ts";
import {
  buildTeamGetInputFromMcp,
  buildTeamGetMcpInputSchema,
  buildTeamListInputFromMcp,
  buildTeamListMcpInputSchema,
  buildTeamMembersListInputFromMcp,
  buildTeamMembersListMcpInputSchema,
  buildWorkflowStatesListInputFromMcp,
  buildWorkflowStatesListMcpInputSchema,
  executeTeamGet,
  executeTeamList,
  executeTeamMembersList,
  executeWorkflowStatesList,
  type TeamGetMcpInput,
  type TeamListMcpInput,
  type TeamMembersListMcpInput,
  teamGetOperation,
  teamListOperation,
  teamListPayload,
  teamMembersListOperation,
  teamMembersListPayload,
  type WorkflowStatesListMcpInput,
  workflowStatesListOperation,
  workflowStatesListPayload,
} from "../../surface/teams.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface TeamToolDeps {
  workspaceParamDescription: string;
  /** Kept for server wiring compatibility; get path throws via surface execute. */
  requireMcpEntity: <T>(value: T | null | undefined, label: string, id: string, hint?: string) => T;
}

const TEAM_GET_NOT_FOUND_HINT = "verify the team key/UUID; run list_teams to discover teams";
const WORKFLOW_STATES_TEAM_NOT_FOUND_HINT = "verify the team key (e.g. 'NOX')";

export function buildTeamToolSpecs(deps: TeamToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_teams",
      config: mcpToolConfig(
        teamListOperation,
        buildTeamListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: TeamListMcpInput) => {
        const result = await executeTeamList(buildTeamListInputFromMcp(args));
        return text(envelope(teamListPayload(result)));
      },
    },
    {
      name: "list_team_members",
      config: mcpToolConfig(
        teamMembersListOperation,
        buildTeamMembersListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: TeamMembersListMcpInput) => {
        const result = await executeTeamMembersList(buildTeamMembersListInputFromMcp(args));
        return text(envelope(teamMembersListPayload(result)));
      },
    },
    {
      name: "get_team",
      config: mcpToolConfig(
        teamGetOperation,
        buildTeamGetMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: TeamGetMcpInput) => {
        const team = await executeTeamGet(buildTeamGetInputFromMcp(args), TEAM_GET_NOT_FOUND_HINT);
        return text(envelope({ team }));
      },
    },
    {
      name: "list_workflow_states",
      config: mcpToolConfig(
        workflowStatesListOperation,
        buildWorkflowStatesListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: WorkflowStatesListMcpInput) => {
        const result = await executeWorkflowStatesList(buildWorkflowStatesListInputFromMcp(args), {
          teamNotFoundHint: WORKFLOW_STATES_TEAM_NOT_FOUND_HINT,
        });
        return text(envelope(workflowStatesListPayload(result)));
      },
    },
  ];
}
