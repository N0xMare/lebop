import { z } from "zod";
import { parseCliLimit } from "../lib/cliOptions.ts";
import { getCycle, type ListedCycle, listCycles } from "../lib/cycles.ts";
import { NotFoundError } from "../lib/errors.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, teamArg, workspaceArg } from "./schema.ts";

export interface CycleListInput {
  team?: string;
  allTeams?: boolean;
  max: number;
}

export interface CycleListCliInput {
  opts: {
    team?: string;
    allTeams?: boolean;
    limit?: string;
  };
}

export type CycleListMcpInput = Record<string, unknown> & {
  team?: string;
  all_teams?: boolean;
  limit?: number;
};

export interface CycleGetInput {
  id: string;
}

export interface CycleListExecutionResult {
  team: string | undefined;
  count: number;
  cycles: ListedCycle[];
}

export interface CycleListDeps {
  resolveTeam: (team: string | undefined) => Promise<string>;
  getTeam: (team: string) => Promise<unknown | null>;
  teamNotFoundHint: string;
}

const cycleListCanonicalSchema = z
  .object({
    team: teamArg,
    allTeams: z.boolean().optional(),
    max: z.union([z.number(), z.literal(Number.POSITIVE_INFINITY)]),
  })
  .strict();

const cycleGetCanonicalSchema = z.object({ id: z.string() }).strict();

export function buildCycleListInputFromCli(input: CycleListCliInput): CycleListInput {
  return parseSurfaceInput("cycles.list", cycleListCanonicalSchema, {
    team: input.opts.team,
    allTeams: input.opts.allTeams,
    max: parseCliLimit(input.opts.limit, { defaultValue: 50, zeroMeansInfinity: true }),
  });
}

export function buildCycleListInputFromMcp(input: CycleListMcpInput): CycleListInput {
  const limit = input.limit ?? 50;
  return parseSurfaceInput("cycles.list", cycleListCanonicalSchema, {
    team: input.team,
    allTeams: input.all_teams,
    max: limit === 0 ? Number.POSITIVE_INFINITY : limit,
  });
}

export function buildCycleGetInput(id: string): CycleGetInput {
  return parseSurfaceInput("cycles.get", cycleGetCanonicalSchema, { id });
}

export async function executeCycleList(
  input: CycleListInput,
  deps: CycleListDeps,
): Promise<CycleListExecutionResult> {
  const team = input.allTeams ? undefined : await deps.resolveTeam(input.team);
  if (!input.allTeams && team) {
    const resolvedTeam = await deps.getTeam(team);
    if (!resolvedTeam) {
      throw new NotFoundError(`team not found: ${team}`, deps.teamNotFoundHint);
    }
  }
  const cycles = await listCycles({ team, max: input.max });
  return {
    team: input.allTeams ? "*" : team,
    count: cycles.length,
    cycles,
  };
}

export function cycleListPayload(result: CycleListExecutionResult) {
  return {
    team: result.team,
    count: result.count,
    cycles: result.cycles,
  };
}

export async function executeCycleGet(
  input: CycleGetInput,
  notFoundHint?: string,
): Promise<ListedCycle> {
  const cycle = await getCycle(input.id);
  if (!cycle) {
    throw new NotFoundError(`cycle not found: ${input.id}`, notFoundHint);
  }
  return cycle;
}

export function buildCycleListMcpInputSchema(workspaceDescription: string) {
  return {
    team: teamArg.describe("Team key. Omit to use the configured default team."),
    all_teams: z
      .boolean()
      .optional()
      .describe("Drop the team filter for workspace-wide cycle listing."),
    limit: z.number().int().min(0).optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCycleGetMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export const cycleListOperation = {
  id: "cycles.list",
  domain: "cycles",
  resource: "cycle",
  action: "list",
  title: "List cycles for a team (or all teams)",
  description: "Cycles are read-only via lebop — manage in the Linear UI.",
  cli: { command: "cycle list", liveSteps: ["cli:cycle list --json"] },
  mcp: {
    tool: "list_cycles",
    title: "List cycles for a team (or all teams)",
    description: "Cycles are read-only via lebop — manage in the Linear UI.",
    annotations: {
      title: "List cycles for a team (or all teams)",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildCycleListInputFromCli,
  fromMcp: buildCycleListInputFromMcp,
} satisfies SurfaceOperationContract<
  CycleListInput,
  CycleListExecutionResult,
  CycleListCliInput,
  CycleListMcpInput
>;

export const cycleGetOperation = {
  id: "cycles.get",
  domain: "cycles",
  resource: "cycle",
  action: "get",
  title: "Get one cycle by UUID",
  description:
    "Returns one cycle. Missing ids surface as structured not_found errors, matching `lebop cycle view --json`.",
  cli: { command: "cycle view", liveSteps: ["cli:cycle view --json"] },
  mcp: {
    tool: "get_cycle",
    title: "Get one cycle by UUID",
    description:
      "Returns one cycle. Missing ids surface as structured not_found errors, matching `lebop cycle view --json`.",
    annotations: {
      title: "Get one cycle by UUID",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
} satisfies SurfaceOperationContract<CycleGetInput, ListedCycle>;

export const CYCLES_SURFACE_OPERATIONS = [cycleListOperation, cycleGetOperation] as const;
