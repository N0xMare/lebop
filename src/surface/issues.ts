import { z } from "zod";
import { buildComments, buildIssueMetadata } from "../lib/build.ts";
import type { BulkUpdateInput, BulkUpdatePatch, BulkUpdateResult } from "../lib/bulk.ts";
import { bulkUpdateIssues } from "../lib/bulk.ts";
import {
  type IssueCacheNotRefreshedSummary,
  issueCacheNotRefreshed,
  summarizeIssueCacheRefresh,
} from "../lib/cacheCoherence.ts";
import {
  type IssueCacheRefreshResult,
  refreshCachedIssueByIdentifier,
} from "../lib/cacheRefresh.ts";
import { parseCliLimit, parseCliNumber } from "../lib/cliOptions.ts";
import { NotFoundError, tryMapToNull, ValidationError } from "../lib/errors.ts";
import { expandIds } from "../lib/expand.ts";
import {
  archiveIssues,
  type CreatedIssue,
  createIssue,
  type FetchedIssue,
  type IssueWriteProof,
  issueWriteProof,
  type CreateIssueInput as LibCreateIssueInput,
  type UpdateIssueInput as LibUpdateIssueInput,
  type LifecycleResult,
  unarchiveIssues,
  updateIssue,
} from "../lib/issues.ts";
import { type ListedIssuesResult, listIssuesWithMetadata } from "../lib/listIssues.ts";
import {
  buildPullIssuesQuery,
  completeInlineIssueComments,
  type IssueCommentsRawRequest,
} from "../lib/pullQuery.ts";
import { withClient } from "../lib/sdk.ts";
import { isUuid } from "../lib/uuid.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, repoRootArg, teamArg, workspaceArg } from "./schema.ts";

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
  search?: string;
  include_archived?: boolean;
  limit?: number;
  cursor?: string;
};

export interface IssueListExecutionResult extends ListedIssuesResult {
  resolvedTeam: string | null;
  allTeams: boolean;
}

export interface IssueGetInput {
  identifier: string;
  includeComments: boolean;
  includeRelations: boolean;
}

export interface IssueGetCliInput {
  id: string;
  opts: { comments?: boolean };
}

export type IssueGetMcpInput = Record<string, unknown> & {
  identifier: string;
  include_comments?: boolean;
  include_relations?: boolean;
};

export interface IssueContextCompleteness {
  comments?: {
    complete: boolean;
    has_more: boolean;
    next_cursor: string | null;
    count: number;
  };
  relations?: {
    complete: boolean;
    has_more: boolean;
    next_cursor: { outbound: string | null; inbound: string | null };
    continuation?: {
      tool: "list_relations";
      arguments: { identifier: string };
      reason: string;
    };
    outbound_count: number;
    inbound_count: number;
  };
}

export interface IssueContext {
  metadata: ReturnType<typeof buildIssueMetadata>["metadata"];
  description: string;
  comments?: ReturnType<typeof buildComments>;
  relations?: ReturnType<typeof buildIssueRelationSummary>;
  completeness: IssueContextCompleteness;
}

export interface IssueCreateInput {
  team?: string;
  title: string;
  description?: string;
  project?: string;
  projectId?: string;
  state?: string;
  priority?: string | number;
  estimate?: number;
  labels?: string[];
  assignee?: string;
  repoRoot?: string;
}

export interface IssueCreateCliInput {
  opts: {
    team?: string;
    title?: string;
    description?: string;
    project?: string;
    projectId?: string;
    state?: string;
    priority?: string;
    estimate?: string;
    label?: string[];
    assignee?: string;
  };
}

export type IssueCreateMcpInput = Record<string, unknown> & {
  team?: string;
  title: string;
  description?: string;
  project?: string;
  project_id?: string;
  state?: string;
  priority?: string | number;
  estimate?: number;
  labels?: string[];
  assignee?: string;
  repo_root?: string;
};

export interface IssueUpdateInput {
  identifier: string;
  team?: string;
  title?: string;
  description?: string;
  state?: string;
  priority?: string | number;
  estimate?: number | null;
  labels?: string[];
  labelDeltas?: { add?: string[]; remove?: string[] };
  assignee?: string | null;
  parent?: string | null;
  project?: string | null;
  milestone?: string | null;
  cycle?: string | null;
  repoRoot?: string;
}

export type IssueUpdateMcpInput = Record<string, unknown> & {
  identifier: string;
  team?: string;
  title?: string;
  description?: string;
  state?: string;
  priority?: string | number;
  estimate?: number | null;
  labels?: string[];
  labels_add?: string[];
  labels_remove?: string[];
  assignee?: string | null;
  parent?: string | null;
  project?: string | null;
  milestone?: string | null;
  cycle?: string | null;
  repo_root?: string;
};

export interface IssueUpdateCliInput {
  input: IssueUpdateInput;
}

export interface IssueUpdateExecutionResult {
  status: "updated" | "updated-writeback-failed";
  issue: FetchedIssue;
  remote: IssueWriteProof;
  cache: IssueCacheRefreshResult;
}

export interface IssueLifecycleInput {
  identifiers: string[];
  repoRoot?: string;
}

export interface IssueArchiveCliInput {
  identifiers: string[];
  opts: { yes?: boolean };
}

export type IssueLifecycleMcpInput = Record<string, unknown> & {
  identifiers: string[];
  repo_root?: string;
};

export interface IssueArchiveExecutionResult {
  results: LifecycleResult[];
  cache: IssueCacheNotRefreshedSummary;
}

export interface IssueUnarchiveExecutionResult {
  results: LifecycleResult[];
  cache: ReturnType<typeof summarizeIssueCacheRefresh>;
}

export interface IssueBulkUpdateInput extends BulkUpdateInput {}

export interface IssueBulkUpdateCliInput {
  identifiers: string[];
  opts: {
    state?: string;
    priority?: string;
    label?: string[];
    assignee?: string;
    estimate?: string;
    project?: string;
    milestone?: string;
    cycle?: string;
    team?: string;
    dryRun?: boolean;
    yes?: boolean;
    confirm?: boolean;
  };
  repoHash?: string;
  repoRoot?: string | null;
}

export type IssueBulkUpdateMcpInput = Record<string, unknown> & {
  identifiers: string[];
  patch: BulkUpdatePatch;
  team?: string;
  dry_run?: boolean;
  confirm?: boolean;
  repo_root?: string;
};

export interface IssueListDeps {
  resolveTeam: (team: string | undefined) => Promise<string>;
  getTeam: (team: string) => Promise<unknown | null>;
}

export interface IssueCreateDeps {
  resolveConfig: (options: {
    cwd?: string;
    teamOverride?: string;
    requireGitRoot?: boolean;
  }) => Promise<{ repoHash: string; team: string }>;
}

export interface IssueRepoCacheContext {
  repoHash: string;
  repoRoot: string | null;
}

export interface IssueRepoCacheDeps {
  resolveCacheContext: (repoRoot: string | undefined) => IssueRepoCacheContext;
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
    search: z.string().optional(),
    includeArchived: z.boolean().optional(),
    max: z.union([z.number(), z.literal(Number.POSITIVE_INFINITY)]),
    cursor: z.string().optional(),
  })
  .strict();

const issueGetCanonicalSchema: z.ZodType<IssueGetInput> = z
  .object({
    identifier: z.string(),
    includeComments: z.boolean(),
    includeRelations: z.boolean(),
  })
  .strict();

const issueCreateCanonicalSchema: z.ZodType<IssueCreateInput> = z
  .object({
    team: teamArg,
    title: z.string(),
    description: z.string().optional(),
    project: z.string().optional(),
    projectId: z.string().optional(),
    state: z.string().optional(),
    priority: z.union([z.string(), z.number()]).optional(),
    estimate: z.number().optional(),
    labels: z.array(z.string()).optional(),
    assignee: z.string().optional(),
    repoRoot: repoRootArg,
  })
  .strict();

const issueUpdateCanonicalSchema: z.ZodType<IssueUpdateInput> = z
  .object({
    identifier: z.string(),
    team: teamArg,
    title: z.string().optional(),
    description: z.string().optional(),
    state: z.string().optional(),
    priority: z.union([z.string(), z.number()]).optional(),
    estimate: z.number().nullable().optional(),
    labels: z.array(z.string()).optional(),
    labelDeltas: z
      .object({
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      })
      .optional(),
    assignee: z.string().nullable().optional(),
    parent: z.string().nullable().optional(),
    project: z.string().nullable().optional(),
    milestone: z.string().nullable().optional(),
    cycle: z.string().nullable().optional(),
    repoRoot: repoRootArg,
  })
  .strict();

const issueLifecycleCanonicalSchema: z.ZodType<IssueLifecycleInput> = z
  .object({
    identifiers: z.array(z.string()),
    repoRoot: repoRootArg,
  })
  .strict();

const issueBulkUpdateCanonicalSchema: z.ZodType<IssueBulkUpdateInput> = z
  .object({
    identifiers: z.array(z.string()),
    patch: z.object({
      state: z.string().optional(),
      priority: z.union([z.string(), z.number()]).optional(),
      labels: z.array(z.string()).optional(),
      assignee: z.string().nullable().optional(),
      estimate: z.number().nullable().optional(),
      project: z.string().nullable().optional(),
      milestone: z.string().nullable().optional(),
      cycle: z.string().nullable().optional(),
    }),
    team: teamArg,
    dryRun: z.boolean().optional(),
    repoHash: z.string().optional(),
    repoRoot: z.string().nullable().optional(),
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
    search: input.search,
    includeArchived: input.include_archived,
    max: limit === 0 ? Number.POSITIVE_INFINITY : limit,
    cursor: input.cursor,
  });
}

export function buildIssueGetInputFromCli(input: IssueGetCliInput): IssueGetInput {
  return parseSurfaceInput("issues.get", issueGetCanonicalSchema, {
    identifier: input.id,
    includeComments: input.opts.comments !== false,
    includeRelations: true,
  });
}

export function buildIssueGetInputFromMcp(input: IssueGetMcpInput): IssueGetInput {
  return parseSurfaceInput("issues.get", issueGetCanonicalSchema, {
    identifier: input.identifier,
    includeComments: input.include_comments !== false,
    includeRelations: input.include_relations !== false,
  });
}

export function buildIssueCreateInputFromCli(input: IssueCreateCliInput): IssueCreateInput {
  return parseIssueCreateInput("issues.create", {
    team: input.opts.team,
    title: input.opts.title ?? "",
    description: input.opts.description,
    project: input.opts.project,
    projectId: input.opts.projectId,
    state: input.opts.state,
    priority: input.opts.priority,
    estimate:
      input.opts.estimate === undefined
        ? undefined
        : parseCliNumber(input.opts.estimate, { optionName: "--estimate" }),
    labels: input.opts.label,
    assignee: input.opts.assignee,
  });
}

export function buildIssueCreateInputFromMcp(input: IssueCreateMcpInput): IssueCreateInput {
  return parseIssueCreateInput("issues.create.mcp", {
    team: input.team,
    title: input.title,
    description: input.description,
    project: input.project,
    projectId: input.project_id,
    state: input.state,
    priority: input.priority,
    estimate: input.estimate,
    labels: input.labels,
    assignee: input.assignee,
    repoRoot: input.repo_root,
  });
}

function parseIssueCreateInput(operationId: string, input: IssueCreateInput): IssueCreateInput {
  const parsed = parseSurfaceInput(operationId, issueCreateCanonicalSchema, input);
  if (parsed.project && parsed.projectId) {
    throw new ValidationError(
      operationId.endsWith(".mcp")
        ? "create_issue accepts either project or project_id, not both"
        : "pass exactly one of --project / --project-id, not both",
      operationId.endsWith(".mcp")
        ? "pass project for a team-scoped project name, or project_id for a Linear project UUID"
        : "choose one project selector",
    );
  }
  return parsed;
}

export function buildIssueUpdateInputFromCli(input: IssueUpdateCliInput): IssueUpdateInput {
  return validateIssueUpdateInput(
    parseSurfaceInput("issues.update", issueUpdateCanonicalSchema, input.input),
  );
}

export function buildIssueUpdateInputFromMcp(input: IssueUpdateMcpInput): IssueUpdateInput {
  return validateIssueUpdateInput(
    parseSurfaceInput("issues.update", issueUpdateCanonicalSchema, {
      identifier: input.identifier,
      team: input.team,
      title: input.title,
      description: input.description,
      state: input.state,
      priority: input.priority,
      estimate: input.estimate,
      labels: input.labels,
      labelDeltas:
        input.labels_add !== undefined || input.labels_remove !== undefined
          ? { add: input.labels_add, remove: input.labels_remove }
          : undefined,
      assignee: input.assignee,
      parent: input.parent,
      project: input.project,
      milestone: input.milestone,
      cycle: input.cycle,
      repoRoot: input.repo_root,
    }),
  );
}

export function buildIssueArchiveInputFromCli(input: IssueArchiveCliInput): IssueLifecycleInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      "refusing to archive issues without --yes",
      "re-run with --yes to confirm this destructive state change",
    );
  }
  return validateIssueLifecycleInput(
    parseSurfaceInput("issues.archive", issueLifecycleCanonicalSchema, {
      identifiers: expandIds(input.identifiers),
    }),
    "archive",
  );
}

export function buildIssueArchiveInputFromMcp(input: IssueLifecycleMcpInput): IssueLifecycleInput {
  return validateIssueLifecycleInput(
    parseSurfaceInput("issues.archive", issueLifecycleCanonicalSchema, {
      identifiers: expandIds(input.identifiers),
      repoRoot: input.repo_root,
    }),
    "archive_issue",
  );
}

export function buildIssueUnarchiveInputFromCli(input: {
  identifiers: string[];
}): IssueLifecycleInput {
  return validateIssueLifecycleInput(
    parseSurfaceInput("issues.unarchive", issueLifecycleCanonicalSchema, {
      identifiers: expandIds(input.identifiers),
    }),
    "unarchive",
  );
}

export function buildIssueUnarchiveInputFromMcp(
  input: IssueLifecycleMcpInput,
): IssueLifecycleInput {
  return validateIssueLifecycleInput(
    parseSurfaceInput("issues.unarchive", issueLifecycleCanonicalSchema, {
      identifiers: expandIds(input.identifiers),
      repoRoot: input.repo_root,
    }),
    "unarchive_issue",
  );
}

export function buildIssueBulkUpdateInputFromCli(
  input: IssueBulkUpdateCliInput,
): IssueBulkUpdateInput {
  const patch: BulkUpdatePatch = {};
  if (input.opts.state !== undefined) patch.state = input.opts.state;
  if (input.opts.priority !== undefined) patch.priority = input.opts.priority;
  if (input.opts.label !== undefined) patch.labels = input.opts.label;
  if (input.opts.assignee !== undefined) {
    patch.assignee = input.opts.assignee === "null" ? null : input.opts.assignee;
  }
  if (input.opts.estimate !== undefined) {
    patch.estimate =
      input.opts.estimate === "null"
        ? null
        : parseCliNumber(input.opts.estimate, {
            optionName: "--estimate",
            allowNullHint: true,
          });
  }
  if (input.opts.project !== undefined) {
    patch.project = input.opts.project === "null" ? null : input.opts.project;
  }
  if (input.opts.milestone !== undefined) {
    patch.milestone = input.opts.milestone === "null" ? null : input.opts.milestone;
  }
  if (input.opts.cycle !== undefined) {
    patch.cycle = input.opts.cycle === "null" ? null : input.opts.cycle;
  }
  if (input.opts.dryRun !== true && input.opts.yes !== true && input.opts.confirm !== true) {
    throw new ValidationError(
      "refusing to bulk update issues without --yes",
      "run with --dry-run to preview, or re-run with --yes/--confirm to apply the batch update",
    );
  }

  return validateIssueBulkUpdateInput({
    identifiers: input.identifiers,
    patch,
    team: input.opts.team,
    ...(input.opts.dryRun === undefined ? {} : { dryRun: input.opts.dryRun }),
    repoHash: input.repoHash,
    repoRoot: input.repoRoot,
  });
}

export function buildIssueBulkUpdateInputFromMcp(
  input: IssueBulkUpdateMcpInput,
  deps: IssueRepoCacheDeps,
): IssueBulkUpdateInput {
  const cacheContext = deps.resolveCacheContext(input.repo_root);
  return validateIssueBulkUpdateInput({
    identifiers: input.identifiers,
    patch: input.patch,
    team: input.team,
    ...(input.dry_run === undefined ? {} : { dryRun: input.dry_run }),
    repoHash: cacheContext.repoHash,
    repoRoot: cacheContext.repoRoot,
  });
}

function requireIssueRepoCacheDeps(deps: unknown): IssueRepoCacheDeps {
  const candidate = deps as Partial<IssueRepoCacheDeps> | null | undefined;
  if (!candidate || typeof candidate.resolveCacheContext !== "function") {
    throw new ValidationError(
      "bulk_update_issues MCP adapter requires repo cache dependencies",
      "call the adapter with the same IssueRepoCacheDeps used by the MCP tool registration",
    );
  }
  return candidate as IssueRepoCacheDeps;
}

function validateIssueUpdateInput(input: IssueUpdateInput): IssueUpdateInput {
  const normalized = {
    ...input,
    labelDeltas:
      input.labelDeltas &&
      ((input.labelDeltas.add?.length ?? 0) > 0 || (input.labelDeltas.remove?.length ?? 0) > 0)
        ? input.labelDeltas
        : undefined,
  };
  const { identifier: _identifier, team: _team, repoRoot: _repoRoot, ...fields } = normalized;
  if (normalized.labels !== undefined && normalized.labelDeltas !== undefined) {
    throw new ValidationError(
      "pass either labels or labels_add/labels_remove, not both",
      "use labels for exact replacement, or labels_add/labels_remove for delta updates",
    );
  }
  if (Object.values(fields).every((value) => value === undefined)) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass at least one of title, description, state, priority, estimate, labels, labels_add/labels_remove, assignee, parent, project, milestone, cycle",
    );
  }
  return normalized;
}

function validateIssueLifecycleInput(
  input: IssueLifecycleInput,
  toolName: string,
): IssueLifecycleInput {
  if (input.identifiers.length === 0) {
    throw new ValidationError(
      `${toolName} requires at least one identifiers entry`,
      "pass at least one identifiers value",
    );
  }
  return input;
}

function validateIssueBulkUpdateInput(input: IssueBulkUpdateInput): IssueBulkUpdateInput {
  return parseSurfaceInput("issues.bulk_update", issueBulkUpdateCanonicalSchema, input);
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

export async function executeIssueGet(input: IssueGetInput): Promise<IssueContext | null> {
  const idLooksUuid = isUuid(input.identifier);
  const normalizedId = idLooksUuid ? input.identifier : input.identifier.toUpperCase();
  const query = buildPullIssuesQuery([normalizedId], input.includeComments, input.includeRelations);
  return tryMapToNull(async () => {
    const response = (await withClient((c) => c.client.rawRequest(query))) as {
      data: Record<string, FetchedIssue | null>;
    };
    const issue = response.data.a0;
    if (!issue) return null;
    if (input.includeComments) {
      await completeInlineIssueComments(
        (query, variables) =>
          withClient((c) =>
            c.client.rawRequest(query, variables),
          ) as ReturnType<IssueCommentsRawRequest>,
        [issue],
      );
    }

    const { metadata, description } = buildIssueMetadata(issue);
    return {
      metadata,
      description,
      ...(input.includeComments ? { comments: buildComments(issue) } : {}),
      ...(input.includeRelations ? { relations: buildIssueRelationSummary(issue) } : {}),
      completeness: buildIssueCompleteness(issue, {
        includeComments: input.includeComments,
        includeRelations: input.includeRelations,
      }),
    };
  });
}

export async function executeIssueCreate(
  input: IssueCreateInput,
  deps: IssueCreateDeps,
): Promise<{ issue: CreatedIssue }> {
  const config = await deps.resolveConfig({
    cwd: input.repoRoot,
    teamOverride: input.team,
    requireGitRoot: Boolean(input.repoRoot),
  });
  const issue = await createIssue({
    repoHash: config.repoHash,
    team: config.team,
    title: input.title,
    description: input.description,
    project: input.project,
    projectId: input.projectId,
    state: input.state,
    priority: input.priority,
    estimate: input.estimate,
    labels: input.labels,
    assignee: input.assignee,
  } satisfies LibCreateIssueInput);
  return { issue };
}

export async function executeIssueUpdate(
  input: IssueUpdateInput,
  deps: IssueRepoCacheDeps,
): Promise<IssueUpdateExecutionResult> {
  const cacheContext = deps.resolveCacheContext(input.repoRoot);
  const issue = await updateIssue({
    repoHash: cacheContext.repoHash,
    identifier: input.identifier,
    team: input.team,
    title: input.title,
    description: input.description,
    state: input.state,
    priority: input.priority,
    estimate: input.estimate,
    labels: input.labels,
    labelDeltas: input.labelDeltas,
    assignee: input.assignee,
    parent: input.parent,
    project: input.project,
    milestone: input.milestone,
    cycle: input.cycle,
  } satisfies LibUpdateIssueInput);
  const cache = await depsRefreshIssue(cacheContext, issue.identifier, issue);
  return {
    status: issueUpdateMutationStatus(cache),
    issue,
    remote: issueWriteProof(issue),
    cache,
  };
}

export async function executeIssueArchive(
  input: IssueLifecycleInput,
  deps: IssueRepoCacheDeps,
): Promise<IssueArchiveExecutionResult> {
  const cacheContext = deps.resolveCacheContext(input.repoRoot);
  const results = await archiveIssues(input.identifiers);
  return {
    results,
    cache: issueCacheNotRefreshed({
      identifiers: results.filter((r) => r.status === "ok").map((r) => r.identifier),
      reason:
        "archive_issue does not refresh cached issue rows because normal issue reads may stop returning archived issues",
      repairHint:
        "CLI: run `lebop pull <id> --refresh --yes` after unarchiving and verifying local cache overwrite is intended. MCP: call `pull_issues` with refresh=true and confirm=true. Or remove stale archived rows manually.",
      repoHash: cacheContext.repoHash,
      repoRoot: cacheContext.repoRoot,
    }),
  };
}

export async function executeIssueUnarchive(
  input: IssueLifecycleInput,
  deps: IssueRepoCacheDeps,
): Promise<IssueUnarchiveExecutionResult> {
  const cacheContext = deps.resolveCacheContext(input.repoRoot);
  const results = await unarchiveIssues(input.identifiers);
  const cache = summarizeIssueCacheRefresh(
    await Promise.all(
      results
        .filter((r) => r.status === "ok")
        .map((r) => depsRefreshIssue(cacheContext, r.identifier)),
    ),
  );
  return { results, cache };
}

export async function executeIssueBulkUpdate(
  input: IssueBulkUpdateInput,
): Promise<BulkUpdateResult> {
  return bulkUpdateIssues(input);
}

async function depsRefreshIssue(
  cacheContext: IssueRepoCacheContext,
  identifier: string,
  freshIssue?: FetchedIssue,
): Promise<IssueCacheRefreshResult> {
  return refreshCachedIssueByIdentifier(identifier, {
    repoHash: cacheContext.repoHash,
    repoRoot: cacheContext.repoRoot,
    freshIssue,
  });
}

function issueUpdateMutationStatus(
  cache: IssueCacheRefreshResult,
): "updated" | "updated-writeback-failed" {
  return cache.present && !cache.refreshed && cache.error !== undefined
    ? "updated-writeback-failed"
    : "updated";
}

function buildIssueRelationSummary(issue: FetchedIssue): {
  outbound: { id: string; type: string; identifier: string; title: string }[];
  inbound: { id: string; type: string; identifier: string; title: string }[];
} {
  return {
    outbound: (issue.relations?.nodes ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      identifier: r.relatedIssue.identifier,
      title: r.relatedIssue.title,
    })),
    inbound: (issue.inverseRelations?.nodes ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      identifier: r.issue.identifier,
      title: r.issue.title,
    })),
  };
}

function buildIssueCompleteness(
  issue: FetchedIssue,
  options: { includeComments: boolean; includeRelations: boolean },
): IssueContextCompleteness {
  const out: IssueContextCompleteness = {};
  if (options.includeComments) {
    const pageInfo = issue.comments?.pageInfo ?? { hasNextPage: false, endCursor: null };
    out.comments = {
      complete: !pageInfo.hasNextPage,
      has_more: pageInfo.hasNextPage,
      next_cursor: pageInfo.endCursor ?? null,
      count: issue.comments?.nodes.length ?? 0,
    };
  }
  if (options.includeRelations) {
    const outbound = issue.relations?.pageInfo ?? { hasNextPage: false, endCursor: null };
    const inbound = issue.inverseRelations?.pageInfo ?? { hasNextPage: false, endCursor: null };
    const hasMore = outbound.hasNextPage || inbound.hasNextPage;
    out.relations = {
      complete: !outbound.hasNextPage && !inbound.hasNextPage,
      has_more: hasMore,
      next_cursor: {
        outbound: outbound.endCursor ?? null,
        inbound: inbound.endCursor ?? null,
      },
      ...(hasMore
        ? {
            continuation: {
              tool: "list_relations" as const,
              arguments: { identifier: issue.identifier },
              reason:
                "get_issue returns bounded relation summaries; call list_relations for the complete relation graph.",
            },
          }
        : {}),
      outbound_count: issue.relations?.nodes.length ?? 0,
      inbound_count: issue.inverseRelations?.nodes.length ?? 0,
    };
  }
  return out;
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
    search: z.string().optional().describe("Full-text across title + body."),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(0).optional().describe("0 = no user cap."),
    cursor: z.string().optional().describe("Continue from a previous next_cursor."),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildIssueGetMcpInputSchema(workspaceParamDescription: string) {
  return {
    identifier: z.string().describe("Issue identifier or UUID, e.g. 'NOX-321'."),
    include_comments: z
      .boolean()
      .optional()
      .describe("Default true. Include comments, matching `lebop show --json`."),
    include_relations: z
      .boolean()
      .optional()
      .describe("Default true. Include outbound/inbound relation summaries."),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildIssueCreateMcpInputSchema(workspaceParamDescription: string) {
  return {
    team: teamArg.describe("Team key (e.g. 'NOX'). Defaults to repo config."),
    title: z.string(),
    description: z.string().optional(),
    project: z.string().optional().describe("Project name (resolved against the team)."),
    project_id: z.string().optional().describe("Project UUID (skips name lookup)."),
    state: z.string().optional().describe("State name; defaults to team default state."),
    priority: z
      .union([z.string(), z.number()])
      .optional()
      .describe("'urgent' | 'high' | 'normal' | 'low' | 'none' or 0..4."),
    estimate: z.number().optional(),
    labels: z.array(z.string()).optional().describe("Label names; resolved per team."),
    assignee: z.string().optional().describe("'me' | email | display-name."),
    repo_root: repoRootArg.describe(
      "Repo root whose team-metadata cache should be used for name resolution.",
    ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildIssueUpdateMcpInputSchema(workspaceParamDescription: string) {
  return {
    identifier: z.string().describe("Issue identifier (TEAM-NN)."),
    team: teamArg.describe(
      "Team key. Auto-derived from the issue identifier prefix when omitted (e.g. 'NOX-1' -> 'NOX'). Pass explicitly only to override the derived team. Required when state/labels/assignee names are passed AND the identifier prefix can't be derived.",
    ),
    title: z.string().optional(),
    description: z.string().optional(),
    state: z.string().optional(),
    priority: z.union([z.string(), z.number()]).optional(),
    estimate: z.number().nullable().optional().describe("Number, or null to clear."),
    labels: z.array(z.string()).optional().describe("Replaces the full label set."),
    labels_add: z
      .array(z.string())
      .optional()
      .describe(
        "Label names to add without replacing existing labels. Mutually exclusive with labels.",
      ),
    labels_remove: z
      .array(z.string())
      .optional()
      .describe(
        "Label names to remove without replacing existing labels. Mutually exclusive with labels.",
      ),
    assignee: z.string().nullable().optional().describe("'me'|email|name, or null to clear."),
    parent: z.string().nullable().optional().describe("Parent issue identifier, or null to clear."),
    project: z.string().nullable().optional().describe("Project name or UUID; null to detach."),
    milestone: z
      .string()
      .nullable()
      .optional()
      .describe("Milestone name or UUID; null to detach. Belongs to the issue's project."),
    cycle: z.string().nullable().optional().describe("Cycle name or UUID; null to detach."),
    repo_root: repoRootArg.describe(
      "Repo root whose team-metadata cache and issue cache should be used.",
    ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildIssueArchiveMcpInputSchema(workspaceParamDescription: string) {
  return {
    identifiers: z
      .array(z.string())
      .min(1)
      .describe("Issue identifiers or ranges (TEAM-NN / TEAM-NN..TEAM-MM)."),
    confirm: z.boolean().optional().describe("Required true for destructive execution."),
    repo_root: repoRootArg.describe(
      "Override cwd-derived repo root for cache-coherence reporting.",
    ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildIssueUnarchiveMcpInputSchema(workspaceParamDescription: string) {
  return {
    identifiers: z
      .array(z.string())
      .min(1)
      .describe("Issue identifiers or ranges (TEAM-NN / TEAM-NN..TEAM-MM)."),
    repo_root: repoRootArg.describe(
      "Override cwd-derived repo root for optional cache refresh of updated rows.",
    ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildIssueBulkUpdateMcpInputSchema(workspaceParamDescription: string) {
  return {
    identifiers: z.array(z.string()).min(1).describe("Issue identifiers (TEAM-NN) to update."),
    patch: z
      .object({
        state: z.string().optional(),
        priority: z.union([z.string(), z.number()]).optional(),
        labels: z.array(z.string()).optional(),
        assignee: z.union([z.string(), z.null()]).optional(),
        estimate: z.union([z.number(), z.null()]).optional(),
        project: z.union([z.string(), z.null()]).optional(),
        milestone: z.union([z.string(), z.null()]).optional(),
        cycle: z.union([z.string(), z.null()]).optional(),
      })
      .describe("Patch to apply uniformly to each issue."),
    team: teamArg.describe(
      "Override team for state/labels resolution; otherwise derived from identifier prefix.",
    ),
    dry_run: z
      .boolean()
      .optional()
      .describe("Resolve and preview target rows without mutating Linear."),
    confirm: z
      .boolean()
      .optional()
      .describe("Required true to execute the batch update when dry_run is false or omitted."),
    repo_root: repoRootArg.describe(
      "Override cwd-derived repo root for optional cache refresh of updated rows.",
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

export const issueGetOperation = {
  id: "issues.get",
  domain: "issues",
  resource: "issue",
  action: "get",
  title: "Get a single Linear issue",
  description:
    "Fetch one issue by identifier or UUID. By default returns the same issue context as `lebop show --json` under `issue`: metadata, description, comments, and relation summaries.",
  cli: { command: "show", liveSteps: ["cli:show --json"] },
  mcp: {
    tool: "get_issue",
    title: "Get a single Linear issue",
    description:
      "Fetch one issue by identifier or UUID. By default returns the same issue context as `lebop show --json` under `issue`: metadata, description, comments, and relation summaries. Use include_comments/include_relations=false for a smaller response. Missing identifiers surface as structured not_found errors, matching `lebop show --json`.",
    annotations: {
      title: "Get a single Linear issue",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildIssueGetInputFromCli,
  fromMcp: buildIssueGetInputFromMcp,
} satisfies SurfaceOperationContract<
  IssueGetInput,
  IssueContext | null,
  IssueGetCliInput,
  IssueGetMcpInput
>;

export const issueCreateOperation = {
  id: "issues.create",
  domain: "issues",
  resource: "issue",
  action: "create",
  title: "Create a new Linear issue",
  description:
    "Creates one issue. NOT retry-wrapped — duplicate creation could result if the response is lost mid-call.",
  cli: {
    command: "new",
    liveSteps: ["cli:new --description-file --json", "cli:new --stdin --json"],
  },
  mcp: {
    tool: "create_issue",
    title: "Create a new Linear issue",
    description:
      "Creates one issue. NOT retry-wrapped — duplicate creation could result if the response is lost mid-call.",
    liveSemantics: "required",
    annotations: {
      title: "Create a new Linear issue",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  fromCli: buildIssueCreateInputFromCli,
  fromMcp: buildIssueCreateInputFromMcp,
} satisfies SurfaceOperationContract<
  IssueCreateInput,
  { issue: CreatedIssue },
  IssueCreateCliInput,
  IssueCreateMcpInput
>;

export const issueUpdateOperation = {
  id: "issues.update",
  domain: "issues",
  resource: "issue",
  action: "update",
  title: "Update fields on an existing Linear issue",
  description:
    "Set any combination of: title, description, state, priority, estimate, labels, label deltas, assignee, parent, project, milestone, cycle. Idempotent at the value level — safe to retry.",
  cli: {
    command: "set",
    liveSteps: [
      "cli:set title --json",
      "cli:set state --json",
      "cli:set priority --json",
      "cli:set estimate --json",
      "cli:set assignee --json",
      "cli:set description --json",
      "cli:set project --json",
      "cli:set milestone --json",
      "cli:set cycle --json",
      "cli:set labels exact --json",
      "cli:set parent --json",
      "cli:set parent clear --json",
    ],
  },
  mcp: {
    tool: "update_issue",
    title: "Update fields on an existing Linear issue",
    description:
      "Set any combination of: title, description, state, priority, estimate, labels, labels_add/labels_remove deltas, assignee, parent, project, milestone, cycle. Idempotent at the value level — safe to retry.",
    liveSemantics: "required",
    annotations: {
      title: "Update fields on an existing Linear issue",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  notes:
    "Field parity: CLI set supports direct issue fields one field per invocation, including description/project/milestone/cycle. CLI-only set links maps to relation add/delete semantics; content remains cache/publish-only. MCP update_issue supports the direct issue fields that CLI set supports except set links, and can update multiple fields in one call.",
  fromCli: buildIssueUpdateInputFromCli,
  fromMcp: buildIssueUpdateInputFromMcp,
} satisfies SurfaceOperationContract<
  IssueUpdateInput,
  IssueUpdateExecutionResult,
  IssueUpdateCliInput,
  IssueUpdateMcpInput
>;

export const issueRelationsUpdateOperation = {
  id: "issues.relations_update",
  domain: "issues",
  resource: "issue_relation",
  action: "update",
  title: "Apply relation deltas to an issue",
  description:
    "`lebop set links` and MCP `update_relations` apply one or more relation add/remove deltas for a source issue. Removals and hazardous add preflights require confirmation.",
  cli: { command: "set" },
  mcp: {
    tool: "update_relations",
    title: "Apply relation deltas for one issue",
    description:
      "Batch equivalent of `lebop set links`: apply multiple add/remove relation deltas for one source issue in one MCP call. Removals require confirm:true. Adds require confirm:true only when preflight reports relation replacement or duplicate-state side effects.",
    liveSemantics: "required",
    annotations: {
      title: "Apply relation deltas for one issue",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  notes:
    "Batch relation delta parity for `lebop set links`: applies multiple add/remove relation deltas for one source issue.",
} satisfies SurfaceOperationContract<unknown, unknown>;

export const issueArchiveOperation = {
  id: "issues.archive",
  domain: "issues",
  resource: "issue",
  action: "update",
  title: "Archive one or more issues",
  description:
    "Archives one or more issues (reversible from the Linear UI; reversible programmatically via unarchive_issue). NOT retry-wrapped.",
  cli: {
    command: "archive",
    liveSteps: [
      "cli:archive/unarchive issue --json",
      "cli:archive issue final --json",
      "cli:archive primary evidence issue --json",
    ],
  },
  mcp: {
    tool: "archive_issue",
    title: "Archive one or more issues",
    description:
      "Archives one or more issues (reversible from the Linear UI; reversible programmatically via unarchive_issue). NOT retry-wrapped.",
    annotations: {
      title: "Archive one or more issues",
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
  fromCli: buildIssueArchiveInputFromCli,
  fromMcp: buildIssueArchiveInputFromMcp,
} satisfies SurfaceOperationContract<
  IssueLifecycleInput,
  IssueArchiveExecutionResult,
  IssueArchiveCliInput,
  IssueLifecycleMcpInput
>;

export const issueUnarchiveOperation = {
  id: "issues.unarchive",
  domain: "issues",
  resource: "issue",
  action: "update",
  title: "Unarchive one or more issues",
  description: "Reverse of archive_issue. NOT retry-wrapped.",
  cli: {
    command: "unarchive",
    liveSteps: ["cli:archive/unarchive issue --json", "cli:unarchive issue --json"],
  },
  mcp: {
    tool: "unarchive_issue",
    title: "Unarchive one or more issues",
    description: "Reverse of archive_issue. NOT retry-wrapped.",
    annotations: {
      title: "Unarchive one or more issues",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildIssueUnarchiveInputFromCli,
  fromMcp: buildIssueUnarchiveInputFromMcp,
} satisfies SurfaceOperationContract<
  IssueLifecycleInput,
  IssueUnarchiveExecutionResult,
  { identifiers: string[] },
  IssueLifecycleMcpInput
>;

export const issueBulkUpdateOperation = {
  id: "issues.bulk_update",
  domain: "issues",
  resource: "issue",
  action: "update",
  title: "Apply one patch uniformly to N issues",
  description:
    "Wraps Linear's issueBatchUpdate. Resolves all extras once up front, then fires a single batch mutation with partial-success rows.",
  cli: { command: "bulk update", liveSteps: ["cli:bulk update --json"] },
  mcp: {
    tool: "bulk_update_issues",
    title: "Apply one patch uniformly to N issues",
    description:
      "Wraps Linear's issueBatchUpdate. Resolves all extras (state/labels/assignee/project/milestone/cycle names → UUIDs) ONCE up front, then fires a single batch mutation. Returns partial-success per-row results matching push_changes' shape: each input identifier maps to either {status:'updated', fields} or {status:'failed', error:{code, message, hint}}. Idempotent at the value level.",
    liveSemantics: "required",
    annotations: {
      title: "Apply one patch uniformly to N issues",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  fromCli: buildIssueBulkUpdateInputFromCli,
  fromMcp: (input: IssueBulkUpdateMcpInput, deps?: unknown) =>
    buildIssueBulkUpdateInputFromMcp(input, requireIssueRepoCacheDeps(deps)),
} satisfies SurfaceOperationContract<
  IssueBulkUpdateInput,
  BulkUpdateResult,
  IssueBulkUpdateCliInput,
  IssueBulkUpdateMcpInput
>;

export const ISSUE_SURFACE_OPERATIONS = [
  issueListOperation,
  issueMineOperation,
  issueGetOperation,
  issueCreateOperation,
  issueUpdateOperation,
  issueRelationsUpdateOperation,
  issueArchiveOperation,
  issueUnarchiveOperation,
  issueBulkUpdateOperation,
] as const;
