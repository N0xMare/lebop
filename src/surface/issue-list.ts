import { z } from "zod";
import { parseCliLimit } from "../lib/cliOptions.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import { type ListedIssuesResult, listIssuesWithMetadata } from "../lib/listIssues.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, teamArg, workspaceArg } from "./schema.ts";

const ISSUE_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;
const ACTIVE_STATE_TYPES = ["triage", "backlog", "unstarted", "started"] as const;

type IssueStateType = (typeof ISSUE_STATE_TYPES)[number];

export interface IssueListInput {
  team?: string;
  allTeams?: boolean;
  project?: string;
  projectId?: string;
  state?: string;
  stateType?: IssueStateType;
  stateTypeIn?: IssueStateType[];
  assignee?: string;
  unassigned?: boolean;
  label?: string[];
  priority?: number;
  cycle?: string;
  milestone?: string;
  updatedSince?: string;
  createdAfter?: string;
  dueBefore?: string;
  dueAfter?: string;
  search?: string;
  includeArchived?: boolean;
  max: number;
  cursor?: string;
}

export interface IssueListCliInput {
  opts: {
    team?: string;
    allTeams?: boolean;
    project?: string;
    projectId?: string;
    state?: string;
    stateType?: string;
    assignee?: string;
    unassigned?: boolean;
    label?: string[];
    priority?: string;
    cycle?: string;
    milestone?: string;
    updatedSince?: string;
    createdAfter?: string;
    dueBefore?: string;
    dueAfter?: string;
    search?: string;
    includeArchived?: boolean;
    limit?: string;
    cursor?: string;
  };
}

export interface IssueMineCliInput {
  opts: {
    team?: string;
    allTeams?: boolean;
    allStates?: boolean;
    includeArchived?: boolean;
    stateType?: string;
    label?: string[];
    priority?: string;
    cycle?: string;
    milestone?: string;
    limit?: string;
    cursor?: string;
  };
}

export type IssueListMcpInput = Record<string, unknown> & {
  team?: string;
  all_teams?: boolean;
  project?: string;
  project_id?: string;
  state?: string;
  state_type?: IssueStateType;
  state_type_in?: IssueStateType[];
  active_only?: boolean;
  all_states?: boolean;
  assignee?: string;
  unassigned?: boolean;
  label?: string[];
  priority?: number;
  cycle?: string;
  milestone?: string;
  updated_since?: string;
  created_after?: string;
  due_before?: string;
  due_after?: string;
  search?: string;
  include_archived?: boolean;
  limit?: number;
  cursor?: string;
  /** Slim field projection: default | full | comma list (matches CLI --fields). */
  fields?: string;
};

export interface IssueListExecutionResult extends ListedIssuesResult {
  resolvedTeam: string | null;
  allTeams: boolean;
}

export interface IssueListDeps {
  resolveTeam: (team: string | undefined) => Promise<string>;
  getTeam: (team: string) => Promise<unknown | null>;
}

const issueStateTypeSchema = z.enum(ISSUE_STATE_TYPES);

const issueListCanonicalSchema: z.ZodType<IssueListInput> = z
  .object({
    team: teamArg,
    allTeams: z.boolean().optional(),
    project: z.string().optional(),
    projectId: z.string().optional(),
    state: z.string().optional(),
    stateType: issueStateTypeSchema.optional(),
    stateTypeIn: z.array(issueStateTypeSchema).optional(),
    assignee: z.string().optional(),
    unassigned: z.boolean().optional(),
    label: z.array(z.string()).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    cycle: z.string().optional(),
    milestone: z.string().optional(),
    updatedSince: z.string().optional(),
    createdAfter: z.string().optional(),
    dueBefore: z.string().optional(),
    dueAfter: z.string().optional(),
    search: z.string().optional(),
    includeArchived: z.boolean().optional(),
    max: z.union([z.number(), z.literal(Number.POSITIVE_INFINITY)]),
    cursor: z.string().optional(),
  })
  .strict();

function parseIssueListLimit(limit: string | undefined): number {
  return parseCliLimit(limit, { defaultValue: 50, zeroMeansInfinity: true });
}

function parseIssuePriority(
  value: string | undefined,
  command: "list" | "mine",
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 4) {
    throw new ValidationError(
      `invalid --priority value "${value}"`,
      "priority must be an integer 0..4 (none|urgent|high|normal|low)",
    );
  }
  return parseSurfaceInput(`issues.${command}.priority`, z.number().int().min(0).max(4), n);
}

function issueStateTypeFromCli(value: string | undefined): IssueStateType | undefined {
  if (value === undefined) return undefined;
  return parseSurfaceInput("issues.state_type", issueStateTypeSchema, value);
}

function issueListStateTypeInForMcp(input: IssueListMcpInput): IssueStateType[] | undefined {
  if (input.state_type || (input.state_type_in && input.state_type_in.length > 0)) {
    return input.state_type_in;
  }
  if (input.all_states) return input.state_type_in;
  return input.active_only ? [...ACTIVE_STATE_TYPES] : input.state_type_in;
}

export function buildIssueListInputFromCli(input: IssueListCliInput): IssueListInput {
  return parseSurfaceInput("issues.list", issueListCanonicalSchema, {
    team: input.opts.team,
    allTeams: input.opts.allTeams,
    project: input.opts.project,
    projectId: input.opts.projectId,
    state: input.opts.state,
    stateType: issueStateTypeFromCli(input.opts.stateType),
    assignee: input.opts.assignee,
    unassigned: input.opts.unassigned,
    label: input.opts.label,
    priority: parseIssuePriority(input.opts.priority, "list"),
    cycle: input.opts.cycle,
    milestone: input.opts.milestone,
    updatedSince: input.opts.updatedSince,
    createdAfter: input.opts.createdAfter,
    dueBefore: input.opts.dueBefore,
    dueAfter: input.opts.dueAfter,
    search: input.opts.search,
    includeArchived: input.opts.includeArchived,
    max: parseIssueListLimit(input.opts.limit),
    cursor: input.opts.cursor,
  });
}

export function buildIssueMineInputFromCli(input: IssueMineCliInput): IssueListInput {
  const stateType = issueStateTypeFromCli(input.opts.stateType);
  return parseSurfaceInput("issues.mine", issueListCanonicalSchema, {
    team: input.opts.team,
    allTeams: input.opts.allTeams,
    stateType,
    stateTypeIn: stateType || input.opts.allStates ? undefined : [...ACTIVE_STATE_TYPES],
    assignee: "me",
    label: input.opts.label,
    priority: parseIssuePriority(input.opts.priority, "mine"),
    cycle: input.opts.cycle,
    milestone: input.opts.milestone,
    includeArchived: input.opts.includeArchived,
    max: parseIssueListLimit(input.opts.limit),
    cursor: input.opts.cursor,
  });
}

export function buildIssueListInputFromMcp(input: IssueListMcpInput): IssueListInput {
  if (input.state_type && input.state_type_in && input.state_type_in.length > 0) {
    throw new ValidationError(
      "pass either state_type or state_type_in, not both",
      "use state_type for one type, or state_type_in for multiple types",
    );
  }
  const limit = input.limit ?? 50;
  return parseSurfaceInput("issues.list", issueListCanonicalSchema, {
    team: input.team,
    allTeams: input.all_teams,
    project: input.project,
    projectId: input.project_id,
    state: input.state,
    stateType: input.state_type,
    stateTypeIn: issueListStateTypeInForMcp(input),
    assignee: input.assignee,
    unassigned: input.unassigned,
    label: input.label,
    priority: input.priority,
    cycle: input.cycle,
    milestone: input.milestone,
    updatedSince: input.updated_since,
    createdAfter: input.created_after,
    dueBefore: input.due_before,
    dueAfter: input.due_after,
    search: input.search,
    includeArchived: input.include_archived,
    max: limit === 0 ? Number.POSITIVE_INFINITY : limit,
    cursor: input.cursor,
  });
}

export async function executeIssueList(
  input: IssueListInput,
  deps: IssueListDeps,
): Promise<IssueListExecutionResult> {
  const resolvedTeam = input.allTeams ? undefined : await deps.resolveTeam(input.team);
  if (!input.allTeams && resolvedTeam) {
    const team = await deps.getTeam(resolvedTeam);
    if (!team) {
      throw new NotFoundError(
        `team not found: ${resolvedTeam}`,
        "use `lebop teams` (or the `list_workspaces` MCP tool) to see available team keys",
      );
    }
  }
  const result = await listIssuesWithMetadata({
    resolvedTeam,
    team: input.team,
    allTeams: input.allTeams,
    project: input.project,
    projectId: input.projectId,
    state: input.state,
    stateType: input.stateType,
    stateTypeIn: input.stateTypeIn,
    assignee: input.assignee,
    unassigned: input.unassigned,
    label: input.label,
    priority: input.priority,
    cycle: input.cycle,
    milestone: input.milestone,
    updatedSince: input.updatedSince,
    createdAfter: input.createdAfter,
    dueBefore: input.dueBefore,
    dueAfter: input.dueAfter,
    search: input.search,
    includeArchived: input.includeArchived,
    max: input.max,
    after: input.cursor,
  });
  return { ...result, resolvedTeam: resolvedTeam ?? null, allTeams: input.allTeams === true };
}

export function issueListPayload(result: IssueListExecutionResult) {
  return {
    scope: {
      type: result.allTeams ? "all" : "team",
      team: result.resolvedTeam,
    },
    team: result.resolvedTeam,
    all_teams: result.allTeams,
    count: result.count,
    limit: result.limit,
    has_more: result.has_more,
    next_cursor: result.next_cursor,
    truncated: result.truncated,
    issues: result.issues,
  };
}

export function buildIssueListMcpInputSchema(workspaceParamDescription: string) {
  return {
    team: teamArg.describe(
      "Team key (e.g. 'ENG'). Omit to use the configured default team; set all_teams for workspace-wide search.",
    ),
    all_teams: z
      .boolean()
      .optional()
      .describe("Drop the team filter for workspace-wide search in the selected workspace."),
    project: z.string().optional(),
    project_id: z.string().optional(),
    state: z.string().optional(),
    state_type: issueStateTypeSchema.optional(),
    state_type_in: z
      .array(issueStateTypeSchema)
      .optional()
      .describe("Match any of these state types. Mutually exclusive with state_type."),
    active_only: z
      .boolean()
      .optional()
      .describe(
        "Shortcut for active Linear state types: triage, backlog, unstarted, started. Ignored when state_type or state_type_in is passed.",
      ),
    all_states: z
      .boolean()
      .optional()
      .describe("Include completed and canceled states when active_only is set."),
    assignee: z.string().optional().describe("'me'/'@me', email, name, or '*' for any."),
    unassigned: z.boolean().optional(),
    label: z.array(z.string()).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    cycle: z.string().optional().describe("Cycle name or UUID."),
    milestone: z.string().optional().describe("Project milestone name or UUID."),
    updated_since: z.string().optional().describe("Relative ('7d'/'24h'/'15m') or ISO timestamp."),
    created_after: z.string().optional(),
    due_before: z
      .string()
      .optional()
      .describe("Due date on or before (YYYY-MM-DD / ISO / relative Nd|Nh|Nm)."),
    due_after: z
      .string()
      .optional()
      .describe("Due date on or after (YYYY-MM-DD / ISO / relative Nd|Nh|Nm)."),
    search: z.string().optional().describe("Full-text across title + body."),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(0).optional().describe("0 = no user cap."),
    cursor: z.string().optional().describe("Continue from a previous next_cursor."),
    fields: z
      .string()
      .optional()
      .describe(
        "Dense field projection matching CLI --fields: omit or 'default' for slim (identifier,title,state,assignee); 'full' for all columns; or comma list.",
      ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

const listIssueAnnotations = {
  title: "List Linear issues by filter",
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const issueListDescription =
  "Filter, paginate, and return Linear issues. Same surface as `lebop list` — search, assignee, state, label, project, cycle, milestone, priority, time filters. Returns plain records.";

export const issueListOperation = {
  id: "issues.list",
  domain: "issues",
  resource: "issue",
  action: "list",
  title: "List Linear issues by filter",
  description: issueListDescription,
  cli: { command: "list", liveSteps: ["cli:list --json"] },
  mcp: {
    tool: "list_issues",
    profile: "core",
    title: "List Linear issues by filter",
    description: issueListDescription,
    annotations: listIssueAnnotations,
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildIssueListInputFromCli,
  fromMcp: buildIssueListInputFromMcp,
} satisfies SurfaceOperationContract<
  IssueListInput,
  IssueListExecutionResult,
  IssueListCliInput,
  IssueListMcpInput
>;

export const issueMineOperation = {
  id: "issues.mine",
  aliasOf: "issues.list",
  domain: "issues",
  resource: "issue",
  action: "list",
  title: "List issues assigned to the current user",
  description: "`lebop mine` is the active-work CLI shorthand expressible through list_issues.",
  cli: { command: "mine", liveSteps: ["cli:mine --json"] },
  mcp: {
    tool: "list_issues",
    profile: "core",
    title: "List Linear issues by filter",
    description: issueListDescription,
    annotations: listIssueAnnotations,
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes:
    "Recipe: list_issues({ assignee: 'me', active_only: true }) matches default mine; pass all_states:true to include completed/canceled assigned issues.",
  fromCli: buildIssueMineInputFromCli,
  fromMcp: buildIssueListInputFromMcp,
} satisfies SurfaceOperationContract<
  IssueListInput,
  IssueListExecutionResult,
  IssueMineCliInput,
  IssueListMcpInput
>;
