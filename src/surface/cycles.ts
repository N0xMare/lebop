import { z } from "zod";
import { parseCliLimit } from "../lib/cliOptions.ts";
import {
  archiveCycle,
  createCycle,
  getCycle,
  type ListedCycle,
  listCycles,
  updateCycle,
} from "../lib/cycles.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import { getTeam } from "../lib/teams.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, teamArg, workspaceArg } from "./schema.ts";

// ── Canonical inputs ────────────────────────────────────────────────────────

export interface CycleListInput {
  team?: string;
  allTeams?: boolean;
  includeArchived?: boolean;
  max: number;
}

export interface CycleListCliInput {
  opts: {
    team?: string;
    allTeams?: boolean;
    includeArchived?: boolean;
    limit?: string;
  };
}

export type CycleListMcpInput = Record<string, unknown> & {
  team?: string;
  all_teams?: boolean;
  include_archived?: boolean;
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

export interface CycleCreateInput {
  team?: string;
  startsAt: string;
  endsAt: string;
  name?: string;
  description?: string;
}

export interface CycleCreateCliInput {
  opts: {
    team?: string;
    starts?: string;
    ends?: string;
    name?: string;
    description?: string;
  };
}

export type CycleCreateMcpInput = Record<string, unknown> & {
  team?: string;
  starts_at: string;
  ends_at: string;
  name?: string;
  description?: string;
};

export interface CycleUpdateInput {
  id: string;
  name?: string;
  description?: string | null;
  startsAt?: string;
  endsAt?: string;
  completedAt?: string | null;
}

export interface CycleUpdateCliInput {
  id: string;
  opts: {
    name?: string;
    description?: string;
    starts?: string;
    ends?: string;
    completedAt?: string;
  };
}

export type CycleUpdateMcpInput = Record<string, unknown> & {
  id: string;
  name?: string;
  description?: string | null;
  starts_at?: string;
  ends_at?: string;
  completed_at?: string | null;
};

export interface CycleArchiveInput {
  id: string;
}

export interface CycleArchiveCliInput {
  id: string;
  opts: { yes?: boolean };
}

export type CycleArchiveMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
};

export interface CycleArchiveExecutionResult {
  id: string;
  success: boolean;
}

export interface CycleCreateDeps {
  resolveTeam: (team: string | undefined) => Promise<string>;
  teamNotFoundHint: string;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const cycleListCanonicalSchema = z
  .object({
    team: teamArg,
    allTeams: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
    max: z.union([z.number(), z.literal(Number.POSITIVE_INFINITY)]),
  })
  .strict();

const cycleGetCanonicalSchema = z.object({ id: z.string() }).strict();

const isoDateTimeSchema = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: "must be a valid ISO DateTime",
  });

const cycleCreateCanonicalSchema = z
  .object({
    team: teamArg,
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

const cycleUpdateCanonicalSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.union([z.string(), z.null()]).optional(),
    startsAt: isoDateTimeSchema.optional(),
    endsAt: isoDateTimeSchema.optional(),
    completedAt: z.union([isoDateTimeSchema, z.null()]).optional(),
  })
  .strict();

const cycleArchiveCanonicalSchema = z.object({ id: z.string() }).strict();

// ── Builders ────────────────────────────────────────────────────────────────

export function buildCycleListInputFromCli(input: CycleListCliInput): CycleListInput {
  return parseSurfaceInput("cycles.list", cycleListCanonicalSchema, {
    team: input.opts.team,
    allTeams: input.opts.allTeams,
    includeArchived: input.opts.includeArchived,
    max: parseCliLimit(input.opts.limit, { defaultValue: 50, zeroMeansInfinity: true }),
  });
}

export function buildCycleListInputFromMcp(input: CycleListMcpInput): CycleListInput {
  const limit = input.limit ?? 50;
  return parseSurfaceInput("cycles.list", cycleListCanonicalSchema, {
    team: input.team,
    allTeams: input.all_teams,
    includeArchived: input.include_archived,
    max: limit === 0 ? Number.POSITIVE_INFINITY : limit,
  });
}

export function buildCycleGetInput(id: string): CycleGetInput {
  return parseSurfaceInput("cycles.get", cycleGetCanonicalSchema, { id });
}

export function buildCycleCreateInputFromCli(input: CycleCreateCliInput): CycleCreateInput {
  if (!input.opts.starts) {
    throw new ValidationError(
      "missing required --starts <ISO DateTime>",
      "pass --starts 2026-09-01T00:00:00.000Z (ISO DateTime)",
    );
  }
  if (!input.opts.ends) {
    throw new ValidationError(
      "missing required --ends <ISO DateTime>",
      "pass --ends 2026-09-14T23:59:59.999Z (ISO DateTime)",
    );
  }
  return parseSurfaceInput("cycles.create", cycleCreateCanonicalSchema, {
    team: input.opts.team,
    startsAt: input.opts.starts,
    endsAt: input.opts.ends,
    name: input.opts.name,
    description: input.opts.description,
  });
}

export function buildCycleCreateInputFromMcp(input: CycleCreateMcpInput): CycleCreateInput {
  return parseSurfaceInput("cycles.create", cycleCreateCanonicalSchema, {
    team: input.team,
    startsAt: input.starts_at,
    endsAt: input.ends_at,
    name: input.name,
    description: input.description,
  });
}

function hasCycleUpdateFields(update: CycleUpdateInput): boolean {
  return (
    update.name !== undefined ||
    update.description !== undefined ||
    update.startsAt !== undefined ||
    update.endsAt !== undefined ||
    update.completedAt !== undefined
  );
}

export function buildCycleUpdateInputFromCli(input: CycleUpdateCliInput): CycleUpdateInput {
  const update: CycleUpdateInput = { id: input.id };
  if (input.opts.name !== undefined) update.name = input.opts.name;
  if (input.opts.description !== undefined) {
    update.description = input.opts.description === "null" ? null : input.opts.description;
  }
  if (input.opts.starts !== undefined) update.startsAt = input.opts.starts;
  if (input.opts.ends !== undefined) update.endsAt = input.opts.ends;
  if (input.opts.completedAt !== undefined) {
    update.completedAt = input.opts.completedAt === "null" ? null : input.opts.completedAt;
  }
  if (!hasCycleUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one of --name / --description / --starts / --ends / --completed-at",
      "pass at least one update field",
    );
  }
  return parseSurfaceInput("cycles.update", cycleUpdateCanonicalSchema, update);
}

export function buildCycleUpdateInputFromMcp(input: CycleUpdateMcpInput): CycleUpdateInput {
  const update: CycleUpdateInput = { id: input.id };
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description;
  if (input.starts_at !== undefined) update.startsAt = input.starts_at;
  if (input.ends_at !== undefined) update.endsAt = input.ends_at;
  if (input.completed_at !== undefined) update.completedAt = input.completed_at;
  if (!hasCycleUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass at least one of name, description, starts_at, ends_at, completed_at",
    );
  }
  return parseSurfaceInput("cycles.update", cycleUpdateCanonicalSchema, update);
}

export function buildCycleArchiveInputFromCli(input: CycleArchiveCliInput): CycleArchiveInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to archive cycle ${input.id} without --yes`,
      "re-run with --yes to confirm. Archive unlinks issues from this cycle; there is no unarchive mutation.",
    );
  }
  return parseSurfaceInput("cycles.archive", cycleArchiveCanonicalSchema, { id: input.id });
}

export function buildCycleArchiveInputFromMcp(input: CycleArchiveMcpInput): CycleArchiveInput {
  return parseSurfaceInput("cycles.archive", cycleArchiveCanonicalSchema, { id: input.id });
}

// ── Execute ─────────────────────────────────────────────────────────────────

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
  const cycles = await listCycles({
    team,
    max: input.max,
    includeArchived: Boolean(input.includeArchived),
  });
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

export async function executeCycleCreate(
  input: CycleCreateInput,
  deps: CycleCreateDeps,
): Promise<ListedCycle> {
  const teamKey = await deps.resolveTeam(input.team);
  const team = await getTeam(teamKey);
  if (!team) {
    throw new NotFoundError(`team not found: ${teamKey}`, deps.teamNotFoundHint);
  }
  return createCycle({
    teamId: team.id,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    name: input.name,
    description: input.description,
  });
}

export async function executeCycleUpdate(
  input: CycleUpdateInput,
  notFoundHint?: string,
): Promise<ListedCycle> {
  // Probe existence so missing UUID maps to not_found (not a raw GraphQL error).
  const existing = await getCycle(input.id);
  if (!existing) {
    throw new NotFoundError(`cycle not found: ${input.id}`, notFoundHint);
  }
  return updateCycle(input.id, {
    name: input.name,
    description: input.description,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    completedAt: input.completedAt,
  });
}

export async function executeCycleArchive(
  input: CycleArchiveInput,
  notFoundHint?: string,
): Promise<CycleArchiveExecutionResult> {
  const existing = await getCycle(input.id);
  if (!existing) {
    throw new NotFoundError(`cycle not found: ${input.id}`, notFoundHint);
  }
  const success = await archiveCycle(input.id);
  return { id: input.id, success };
}

// ── Operation contracts ─────────────────────────────────────────────────────

export const CYCLE_MCP_GET_HINT = "verify the cycle UUID; run list_cycles to discover ids";
export const CYCLE_MCP_TEAM_NOT_FOUND_HINT =
  "use list_teams to see available team keys, or pass all_teams: true to skip team scoping";
export const CYCLE_MCP_CREATE_TEAM_HINT =
  "pass team key or omit for the configured default; run list_teams to discover keys";

export const cycleListOperation = {
  id: "cycles.list",
  domain: "cycles",
  resource: "cycle",
  action: "list",
  title: "List cycles for a team (or all teams)",
  description:
    "List team cycles (iterations). includes description + is_active/is_next/is_past/is_future/is_previous; include_archived for archived rows. get_cycle for one cycle.",
  cli: { command: "cycle list", liveSteps: ["cli:cycle list --json"] },
  mcp: {
    tool: "list_cycles",
    title: "List cycles for a team (or all teams)",
    description:
      "List team cycles (iterations). description + is_active/is_next/is_past/is_future/is_previous; include_archived for archived. get_cycle for one.",
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
  description: "Get one cycle by UUID (description + status flags). not_found if missing.",
  cli: { command: "cycle view", liveSteps: ["cli:cycle view --json"] },
  mcp: {
    tool: "get_cycle",
    title: "Get one cycle by UUID",
    description: "Get one cycle by UUID (description + status flags). not_found if missing.",
    annotations: {
      title: "Get one cycle by UUID",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
} satisfies SurfaceOperationContract<CycleGetInput, ListedCycle>;

export const cycleCreateOperation = {
  id: "cycles.create",
  domain: "cycles",
  resource: "cycle",
  action: "create",
  title: "Create a team cycle",
  description:
    "Create a cycle (team + starts_at + ends_at ISO DateTime). number is server-assigned. NOT retry-wrapped. Prefer updating existing future cycles when a runway already exists.",
  cli: { command: "cycle create", liveSteps: ["cli:cycle create --json"] },
  mcp: {
    tool: "create_cycle",
    title: "Create a team cycle",
    description:
      "Create cycle (team + starts_at + ends_at ISO DateTime). number server-assigned. NOT retry-wrapped.",
    annotations: {
      title: "Create a team cycle",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  fromCli: buildCycleCreateInputFromCli,
  fromMcp: buildCycleCreateInputFromMcp,
} satisfies SurfaceOperationContract<
  CycleCreateInput,
  ListedCycle,
  CycleCreateCliInput,
  CycleCreateMcpInput
>;

export const cycleUpdateOperation = {
  id: "cycles.update",
  domain: "cycles",
  resource: "cycle",
  action: "update",
  title: "Update a cycle",
  description:
    "Update name/description/starts_at/ends_at/completed_at. completed_at marks complete; null clears. Value-level idempotent.",
  cli: { command: "cycle update", liveSteps: ["cli:cycle update --json"] },
  mcp: {
    tool: "update_cycle",
    title: "Update a cycle",
    description:
      "Update name/description/starts_at/ends_at/completed_at. completed_at marks complete; null clears. Value-level idempotent.",
    annotations: {
      title: "Update a cycle",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  notes: "CLI clears description/completed-at with string `null`; MCP accepts JSON null.",
  fromCli: buildCycleUpdateInputFromCli,
  fromMcp: buildCycleUpdateInputFromMcp,
} satisfies SurfaceOperationContract<
  CycleUpdateInput,
  ListedCycle,
  CycleUpdateCliInput,
  CycleUpdateMcpInput
>;

export const cycleArchiveOperation = {
  id: "cycles.archive",
  domain: "cycles",
  resource: "cycle",
  action: "update",
  title: "Archive a cycle",
  description:
    "Archive a cycle by UUID. Unlinks all issues on the cycle first. No unarchive mutation. NOT retry-wrapped.",
  cli: { command: "cycle archive", liveSteps: ["cli:cycle archive --json"] },
  mcp: {
    tool: "archive_cycle",
    title: "Archive a cycle",
    description:
      "Archive cycle by UUID. Unlinks issues on the cycle first. No unarchive. NOT retry-wrapped.",
    annotations: {
      title: "Archive a cycle",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildCycleArchiveInputFromCli,
  fromMcp: buildCycleArchiveInputFromMcp,
} satisfies SurfaceOperationContract<
  CycleArchiveInput,
  CycleArchiveExecutionResult,
  CycleArchiveCliInput,
  CycleArchiveMcpInput
>;

export const CYCLES_SURFACE_OPERATIONS = [
  cycleListOperation,
  cycleGetOperation,
  cycleCreateOperation,
  cycleUpdateOperation,
  cycleArchiveOperation,
] as const;

// ── MCP input schemas ───────────────────────────────────────────────────────

export function buildCycleListMcpInputSchema(workspaceDescription: string) {
  return {
    team: teamArg.describe("Team key. Omit to use the configured default team."),
    all_teams: z
      .boolean()
      .optional()
      .describe("Drop the team filter for workspace-wide cycle listing."),
    include_archived: z
      .boolean()
      .optional()
      .describe("Include archived cycles. Defaults to false (live only)."),
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

export function buildCycleCreateMcpInputSchema(workspaceDescription: string) {
  return {
    team: teamArg.describe("Team key. Omit for the configured default team."),
    starts_at: z.string().describe("Cycle start (ISO DateTime)."),
    ends_at: z.string().describe("Cycle end (ISO DateTime)."),
    name: z.string().optional().describe("Optional custom name (else Linear shows Cycle N)."),
    description: z.string().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCycleUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Cycle UUID."),
    name: z.string().optional(),
    description: z.string().nullable().optional().describe("Set or null to clear."),
    starts_at: z.string().optional().describe("ISO DateTime."),
    ends_at: z.string().optional().describe("ISO DateTime."),
    completed_at: z
      .string()
      .nullable()
      .optional()
      .describe("ISO DateTime to mark complete; null clears completion."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCycleArchiveMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Cycle UUID."),
    confirm: z
      .boolean()
      .optional()
      .describe("Required true. Archive unlinks issues from the cycle; no unarchive."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}
