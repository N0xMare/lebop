import { resolveConfig } from "../../lib/config.ts";
import { envelope } from "../../lib/envelope.ts";
import { getTeam } from "../../lib/teams.ts";
import {
  buildCycleGetInput,
  buildCycleGetMcpInputSchema,
  buildCycleListInputFromMcp,
  buildCycleListMcpInputSchema,
  type CycleListMcpInput,
  cycleGetOperation,
  cycleListOperation,
  cycleListPayload,
  executeCycleGet,
  executeCycleList,
} from "../../surface/cycles.ts";
import { text } from "../response.ts";
import type { McpToolSpec, ToolHandlerArgs } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface CycleToolDeps {
  workspaceParamDescription: string;
  /** Kept for server wiring compatibility; get path throws via surface execute. */
  requireMcpEntity: <T>(value: T | null | undefined, label: string, id: string, hint?: string) => T;
}

const CYCLE_LIST_TEAM_NOT_FOUND_HINT =
  "use list_teams to see available team keys, or pass all_teams: true to skip team scoping";

const CYCLE_GET_NOT_FOUND_HINT = "verify the cycle UUID; run list_cycles to discover ids";

export function buildCyclesToolSpecs(deps: CycleToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_cycles",
      config: mcpToolConfig(
        cycleListOperation,
        buildCycleListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CycleListMcpInput) => {
        const result = await executeCycleList(buildCycleListInputFromMcp(args), {
          resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
          getTeam,
          teamNotFoundHint: CYCLE_LIST_TEAM_NOT_FOUND_HINT,
        });
        return text(envelope(cycleListPayload(result)));
      },
    },
    {
      name: "get_cycle",
      config: mcpToolConfig(
        cycleGetOperation,
        buildCycleGetMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ToolHandlerArgs) => {
        const cycle = await executeCycleGet(
          buildCycleGetInput(args.id as string),
          CYCLE_GET_NOT_FOUND_HINT,
        );
        return text(envelope({ cycle }));
      },
    },
  ];
}
