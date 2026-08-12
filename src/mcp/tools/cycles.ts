import { resolveConfig } from "../../lib/config.ts";
import { envelope } from "../../lib/envelope.ts";
import { mcpGetNext } from "../../lib/nextStubs.ts";
import { getTeam } from "../../lib/teams.ts";
import {
  buildCycleArchiveInputFromMcp,
  buildCycleArchiveMcpInputSchema,
  buildCycleCreateInputFromMcp,
  buildCycleCreateMcpInputSchema,
  buildCycleGetInput,
  buildCycleGetMcpInputSchema,
  buildCycleListInputFromMcp,
  buildCycleListMcpInputSchema,
  buildCycleUpdateInputFromMcp,
  buildCycleUpdateMcpInputSchema,
  CYCLE_MCP_CREATE_TEAM_HINT,
  CYCLE_MCP_GET_HINT,
  CYCLE_MCP_TEAM_NOT_FOUND_HINT,
  type CycleArchiveMcpInput,
  type CycleCreateMcpInput,
  type CycleListMcpInput,
  type CycleUpdateMcpInput,
  cycleArchiveOperation,
  cycleCreateOperation,
  cycleGetOperation,
  cycleListOperation,
  cycleListPayload,
  cycleUpdateOperation,
  executeCycleArchive,
  executeCycleCreate,
  executeCycleGet,
  executeCycleList,
  executeCycleUpdate,
} from "../../surface/cycles.ts";
import { text } from "../response.ts";
import type { McpToolSpec, ToolHandlerArgs } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface CycleToolDeps {
  workspaceParamDescription: string;
  /** Kept for server wiring compatibility; get path throws via surface execute. */
  requireMcpEntity: <T>(value: T | null | undefined, label: string, id: string, hint?: string) => T;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

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
          teamNotFoundHint: CYCLE_MCP_TEAM_NOT_FOUND_HINT,
        });
        return text(
          envelope({
            ...cycleListPayload(result),
            next: mcpGetNext("get_cycle", "list_issues", "update_issue"),
          }),
        );
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
          CYCLE_MCP_GET_HINT,
        );
        return text(
          envelope({ cycle, next: mcpGetNext("list_issues", "update_issue", "list_cycles") }),
        );
      },
    },
    {
      name: "create_cycle",
      config: mcpToolConfig(
        cycleCreateOperation,
        buildCycleCreateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CycleCreateMcpInput) => {
        const cycle = await executeCycleCreate(buildCycleCreateInputFromMcp(args), {
          resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
          teamNotFoundHint: CYCLE_MCP_CREATE_TEAM_HINT,
        });
        return text(envelope({ cycle, next: mcpGetNext("get_cycle", "list_cycles") }));
      },
    },
    {
      name: "update_cycle",
      config: mcpToolConfig(
        cycleUpdateOperation,
        buildCycleUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CycleUpdateMcpInput) => {
        const cycle = await executeCycleUpdate(
          buildCycleUpdateInputFromMcp(args),
          CYCLE_MCP_GET_HINT,
        );
        return text(envelope({ cycle, next: mcpGetNext("get_cycle", "list_cycles") }));
      },
    },
    {
      name: "archive_cycle",
      config: mcpToolConfig(
        cycleArchiveOperation,
        buildCycleArchiveMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CycleArchiveMcpInput) => {
        deps.requireConfirm(args, "archive_cycle");
        const result = await executeCycleArchive(
          buildCycleArchiveInputFromMcp(args),
          CYCLE_MCP_GET_HINT,
        );
        return text(envelope({ ...result, next: mcpGetNext("list_cycles") }));
      },
    },
  ];
}
