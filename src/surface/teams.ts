import { z } from "zod";
import { resolveConfig } from "../lib/config.ts";
import { NotFoundError } from "../lib/errors.ts";
import { paginateConnection } from "../lib/paginate.ts";
import { linear } from "../lib/sdk.ts";
import { type ListedTeamMember, listTeamMembers } from "../lib/teamMembers.ts";
import { type FetchedTeam, getTeam } from "../lib/teams.ts";
import { listWorkflowStates, type WorkflowState } from "../lib/workflowStates.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, teamArg, workspaceArg } from "./schema.ts";

// ---------------------------------------------------------------------------
// Canonical inputs / results
// ---------------------------------------------------------------------------

/** Workspace-wide list; no channel-specific filters. */
export type TeamListInput = Record<string, never>;

export type TeamListCliInput = Record<string, never>;
export type TeamListMcpInput = Record<string, unknown>;

export interface ListedTeamRecord {
  key: string;
  name: string;
  id: string;
  description: string | null;
}

export interface TeamListExecutionResult {
  teams: ListedTeamRecord[];
}

export interface TeamMembersListInput {
  team?: string;
  includeInactive?: boolean;
}

export interface TeamMembersListCliInput {
  teamKey?: string;
  opts: {
    all?: boolean;
  };
}

export type TeamMembersListMcpInput = Record<string, unknown> & {
  team?: string;
  include_inactive?: boolean;
};

export interface TeamMembersListExecutionResult {
  team: string;
  count: number;
  members: ListedTeamMember[];
}

export interface TeamGetInput {
  id: string;
}

export interface TeamGetCliInput {
  keyOrId: string;
}

export type TeamGetMcpInput = Record<string, unknown> & {
  id: string;
};

export interface WorkflowStatesListInput {
  team?: string;
}

export interface WorkflowStatesListCliInput {
  teamKey?: string;
}

export type WorkflowStatesListMcpInput = Record<string, unknown> & {
  team?: string;
};

export interface WorkflowStatesListExecutionResult {
  team: string;
  count: number;
  states: WorkflowState[];
}

export interface WorkflowStatesListDeps {
  teamNotFoundHint: string;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const teamListCanonicalSchema = z.object({}).strict();

const teamMembersListCanonicalSchema = z
  .object({
    team: z.string().optional(),
    includeInactive: z.boolean().optional(),
  })
  .strict();

const teamGetCanonicalSchema = z.object({ id: z.string() }).strict();

const workflowStatesListCanonicalSchema = z
  .object({
    team: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Input builders
// ---------------------------------------------------------------------------

export function buildTeamListInputFromCli(_input?: TeamListCliInput): TeamListInput {
  return parseSurfaceInput("teams.list", teamListCanonicalSchema, {});
}

export function buildTeamListInputFromMcp(_input?: TeamListMcpInput): TeamListInput {
  return parseSurfaceInput("teams.list", teamListCanonicalSchema, {});
}

export function buildTeamMembersListInputFromCli(
  input: TeamMembersListCliInput,
): TeamMembersListInput {
  return parseSurfaceInput("teams.list_members", teamMembersListCanonicalSchema, {
    team: input.teamKey,
    includeInactive: input.opts.all,
  });
}

export function buildTeamMembersListInputFromMcp(
  input: TeamMembersListMcpInput,
): TeamMembersListInput {
  return parseSurfaceInput("teams.list_members", teamMembersListCanonicalSchema, {
    team: input.team,
    includeInactive: input.include_inactive,
  });
}

export function buildTeamGetInputFromCli(input: TeamGetCliInput): TeamGetInput {
  return parseSurfaceInput("teams.get", teamGetCanonicalSchema, { id: input.keyOrId });
}

export function buildTeamGetInputFromMcp(input: TeamGetMcpInput): TeamGetInput {
  return parseSurfaceInput("teams.get", teamGetCanonicalSchema, { id: input.id });
}

export function buildTeamGetInput(id: string): TeamGetInput {
  return parseSurfaceInput("teams.get", teamGetCanonicalSchema, { id });
}

export function buildWorkflowStatesListInputFromCli(
  input: WorkflowStatesListCliInput,
): WorkflowStatesListInput {
  return parseSurfaceInput("teams.list_workflow_states", workflowStatesListCanonicalSchema, {
    team: input.teamKey,
  });
}

export function buildWorkflowStatesListInputFromMcp(
  input: WorkflowStatesListMcpInput,
): WorkflowStatesListInput {
  return parseSurfaceInput("teams.list_workflow_states", workflowStatesListCanonicalSchema, {
    team: input.team,
  });
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function executeTeamList(
  _input: TeamListInput = {},
): Promise<TeamListExecutionResult> {
  // Use linear() + paginateConnection (not withClient): paginateConnection
  // already wraps each page in withRetry. Nesting withClient would double-
  // retry and break the rate-limit budget (cli rate-limit integration test).
  const client = await linear();
  const teams = await paginateConnection(({ first, after }) => client.teams({ first, after }));
  return {
    teams: teams.map((team) => ({
      key: team.key,
      name: team.name,
      id: team.id,
      description: team.description ?? null,
    })),
  };
}

export function teamListPayload(result: TeamListExecutionResult) {
  return { teams: result.teams };
}

export async function executeTeamMembersList(
  input: TeamMembersListInput,
): Promise<TeamMembersListExecutionResult> {
  const config = await resolveConfig({ teamOverride: input.team });
  const members = await listTeamMembers({
    teamKey: config.team,
    includeInactive: input.includeInactive,
  });
  return {
    team: config.team,
    count: members.length,
    members,
  };
}

export function teamMembersListPayload(result: TeamMembersListExecutionResult) {
  return {
    team: result.team,
    count: result.count,
    members: result.members,
  };
}

export async function executeTeamGet(
  input: TeamGetInput,
  notFoundHint?: string,
): Promise<FetchedTeam> {
  const team = await getTeam(input.id);
  if (!team) {
    throw new NotFoundError(`team not found: ${input.id}`, notFoundHint);
  }
  return team;
}

export async function executeWorkflowStatesList(
  input: WorkflowStatesListInput,
  deps: WorkflowStatesListDeps,
): Promise<WorkflowStatesListExecutionResult> {
  const config = await resolveConfig({ teamOverride: input.team });
  const result = await listWorkflowStates(config.team);
  if (!result) {
    throw new NotFoundError(`team not found: ${config.team}`, deps.teamNotFoundHint);
  }
  return {
    team: result.team,
    count: result.states.length,
    states: result.states,
  };
}

export function workflowStatesListPayload(result: WorkflowStatesListExecutionResult) {
  return {
    team: result.team,
    count: result.count,
    states: result.states,
  };
}

// ---------------------------------------------------------------------------
// MCP input schemas
// ---------------------------------------------------------------------------

export function buildTeamListMcpInputSchema(workspaceDescription: string) {
  return {
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildTeamMembersListMcpInputSchema(workspaceDescription: string) {
  return {
    // Renamed from `team_key` → `team` in v0.0.2 for consistency with
    // every other tool that takes a team identifier. The lib still
    // calls the value a `teamKey` internally; the MCP boundary
    // normalizes naming. RELEASE NOTE BREAKING CHANGE: MCP clients
    // wiring up list_team_members must rename `team_key` → `team`.
    team: teamArg.describe("Team key (e.g. 'NOX'). Omit to use the configured default team."),
    include_inactive: z.boolean().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildTeamGetMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Team key (e.g. 'ENG') OR UUID."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildWorkflowStatesListMcpInputSchema(workspaceDescription: string) {
  return {
    team: teamArg.describe("Team key. Omit to use the configured default team."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

// ---------------------------------------------------------------------------
// Operation contracts
// ---------------------------------------------------------------------------

const listTeamsDescription =
  "MCP parity with `lebop teams`: returns accessible teams with key, name, id, and description.";
const listTeamMembersDescription = "Pass include_inactive=true to see deactivated users.";
const getTeamDescription =
  "Returns one team (with default-state). Missing ids/keys surface as structured not_found errors, matching `lebop team get --json`. Wires the team-key → UUID gap that bites create_label and create_project. `id` accepts a team key (e.g. 'ENG') OR a UUID.";
const listWorkflowStatesDescription =
  "Per-team workflow states (Backlog, Todo, In Progress, Done, Cancelled — varies per team setup). Thin wrapper over the team-metadata cache + a live states() fetch for color + default flag.";

export const teamListOperation = {
  id: "teams.list",
  domain: "teams",
  resource: "team",
  action: "list",
  title: "List teams in the Linear workspace",
  description: listTeamsDescription,
  cli: { command: "teams", liveSteps: ["cli:teams --json"] },
  mcp: {
    tool: "list_teams",
    title: "List teams in the Linear workspace",
    description: listTeamsDescription,
    annotations: {
      title: "List teams in the Linear workspace",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildTeamListInputFromCli,
  fromMcp: buildTeamListInputFromMcp,
  execute: executeTeamList,
} satisfies SurfaceOperationContract<
  TeamListInput,
  TeamListExecutionResult,
  TeamListCliInput,
  TeamListMcpInput
>;

export const teamMembersListOperation = {
  id: "teams.list_members",
  domain: "teams",
  resource: "team_member",
  action: "list",
  title: "List members of a team",
  description: listTeamMembersDescription,
  cli: { command: "team members", liveSteps: ["cli:team members --json"] },
  mcp: {
    tool: "list_team_members",
    title: "List members of a team",
    description: listTeamMembersDescription,
    annotations: {
      title: "List members of a team",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["team", "include_inactive", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildTeamMembersListInputFromCli,
  fromMcp: buildTeamMembersListInputFromMcp,
  execute: executeTeamMembersList,
} satisfies SurfaceOperationContract<
  TeamMembersListInput,
  TeamMembersListExecutionResult,
  TeamMembersListCliInput,
  TeamMembersListMcpInput
>;

export const teamGetOperation = {
  id: "teams.get",
  domain: "teams",
  resource: "team",
  action: "get",
  title: "Get one team by key or UUID",
  description: getTeamDescription,
  cli: { command: "team get", liveSteps: ["cli:team get --json"] },
  mcp: {
    tool: "get_team",
    title: "Get one team by key or UUID",
    description: getTeamDescription,
    annotations: {
      title: "Get one team by key or UUID",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes:
    "Not-found hints stay adapter-specific (CLI: lebop teams discovery; MCP: list_teams discovery).",
  fromCli: buildTeamGetInputFromCli,
  fromMcp: buildTeamGetInputFromMcp,
} satisfies SurfaceOperationContract<TeamGetInput, FetchedTeam, TeamGetCliInput, TeamGetMcpInput>;

export const workflowStatesListOperation = {
  id: "teams.list_workflow_states",
  domain: "teams",
  resource: "workflow_state",
  action: "list",
  title: "List workflow states for a team",
  description: listWorkflowStatesDescription,
  cli: { command: "team workflow-states", liveSteps: ["cli:team workflow-states --json"] },
  mcp: {
    tool: "list_workflow_states",
    title: "List workflow states for a team",
    description: listWorkflowStatesDescription,
    annotations: {
      title: "List workflow states for a team",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["team", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes: "Team-not-found hints stay adapter-specific via WorkflowStatesListDeps.teamNotFoundHint.",
  fromCli: buildWorkflowStatesListInputFromCli,
  fromMcp: buildWorkflowStatesListInputFromMcp,
} satisfies SurfaceOperationContract<
  WorkflowStatesListInput,
  WorkflowStatesListExecutionResult,
  WorkflowStatesListCliInput,
  WorkflowStatesListMcpInput
>;

export const TEAMS_SURFACE_OPERATIONS = [
  teamListOperation,
  teamMembersListOperation,
  teamGetOperation,
  workflowStatesListOperation,
] as const;
