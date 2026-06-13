import { z } from "zod";
import type { ProjectCacheRefreshResult } from "../lib/cacheRefresh.ts";
import { parseCliLimit } from "../lib/cliOptions.ts";
import { NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import {
  createProject,
  deleteProject,
  type FullProject,
  getProject,
  type ListedProject,
  listProjects,
  listProjectsPage,
  updateProject,
} from "../lib/projects.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, repoRootArg, teamArg, workspaceArg } from "./schema.ts";

type ProjectUpdateInput = Parameters<typeof updateProject>[1];

export interface ProjectListInput {
  team?: string;
  allTeams?: boolean;
  state?: string;
  includeArchived?: boolean;
  max: number;
  cursor?: string;
}

export interface ProjectListCliInput {
  opts: {
    team?: string;
    allTeams?: boolean;
    state?: string;
    includeArchived?: boolean;
    limit?: string;
    cursor?: string;
  };
}

export type ProjectListMcpInput = Record<string, unknown> & {
  team?: string;
  all_teams?: boolean;
  state?: string;
  include_archived?: boolean;
  limit?: number;
  cursor?: string;
};

export interface ProjectGetInput {
  id: string;
}

export interface ProjectCreateInput {
  name: string;
  teamIds: string[];
  teamKeys: string[];
  description?: string;
  content?: string;
  icon?: string;
  state?: string;
  startDate?: string;
  targetDate?: string;
}

export interface ProjectCreateCliInput {
  name: string;
  opts: {
    team?: string;
    teamKey?: string[];
    teamId?: string[];
    description?: string;
    content?: string;
    icon?: string;
    state?: string;
    startDate?: string;
    targetDate?: string;
  };
}

export type ProjectCreateMcpInput = Record<string, unknown> & {
  name: string;
  team_ids?: string[];
  team_keys?: string[];
  team?: string;
  description?: string;
  content?: string;
  icon?: string;
  state?: string;
  start_date?: string;
  target_date?: string;
};

export interface ProjectUpdateCanonicalInput {
  id: string;
  update: ProjectUpdateInput;
  repoRoot?: string;
}

export interface ProjectUpdateCliInput {
  id: string;
  opts: {
    name?: string;
    description?: string;
    content?: string;
    icon?: string;
    state?: string;
    startDate?: string;
    targetDate?: string;
  };
}

export type ProjectUpdateMcpInput = Record<string, unknown> & {
  id: string;
  name?: string;
  description?: string;
  content?: string;
  icon?: string | null;
  state?: string;
  start_date?: string | null;
  target_date?: string | null;
  repo_root?: string;
};

export interface ProjectDeleteInput {
  id: string;
}

export interface ProjectDeleteCliInput {
  id: string;
  opts: {
    yes?: boolean;
  };
}

export type ProjectDeleteMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
};

export interface ProjectListExecutionResult {
  team: string;
  teamFilter?: string;
  records: ListedProject[];
  count: number;
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  truncated: boolean;
}

export interface ProjectCreateExecutionResult {
  project: FullProject;
  teamIds: string[];
}

export interface ProjectUpdateExecutionResult {
  status: "updated" | "updated-writeback-failed";
  project: FullProject;
  cache: ProjectCacheRefreshResult;
}

export interface ProjectDeleteExecutionResult {
  id: string;
  status: "deleted" | "already-absent";
  success: boolean;
}

export interface ProjectListDeps {
  resolveTeam: (team: string | undefined) => Promise<string>;
}

export interface ProjectCreateTeamDeps {
  defaultTeamKey: () => Promise<string>;
  resolveTeamKeyToId: (team: string) => Promise<string>;
}

export interface ProjectUpdateDeps {
  refreshCache: (
    project: FullProject,
    context?: { repoHash?: string; repoRoot?: string | null },
  ) => Promise<ProjectCacheRefreshResult>;
  resolveCacheContext?: (repoRoot: string | undefined) => {
    repoHash: string;
    repoRoot: string | null;
  };
}

const projectListCanonicalSchema = z
  .object({
    team: z.string().optional(),
    allTeams: z.boolean().optional(),
    state: z.string().optional(),
    includeArchived: z.boolean().optional(),
    cursor: z.string().min(1).optional(),
    max: z.union([z.number(), z.literal(Number.POSITIVE_INFINITY)]),
  })
  .strict();

const projectGetCanonicalSchema = z.object({ id: z.string() }).strict();

const projectCreateCanonicalSchema = z
  .object({
    name: z.string(),
    teamIds: z.array(z.string()),
    teamKeys: z.array(z.string()),
    description: z.string().optional(),
    content: z.string().optional(),
    icon: z.string().optional(),
    state: z.string().optional(),
    startDate: z.string().optional(),
    targetDate: z.string().optional(),
  })
  .strict();

const projectUpdateCanonicalSchema = z
  .object({
    id: z.string(),
    update: z.record(z.string(), z.unknown()),
    repoRoot: repoRootArg,
  })
  .strict();

const projectDeleteCanonicalSchema = z.object({ id: z.string() }).strict();

export function buildProjectListInputFromCli(input: ProjectListCliInput): ProjectListInput {
  return validateProjectListInput(
    parseSurfaceInput("projects.list", projectListCanonicalSchema, {
      team: input.opts.team,
      allTeams: input.opts.allTeams,
      state: input.opts.state,
      includeArchived: input.opts.includeArchived,
      cursor: input.opts.cursor,
      max: parseProjectListLimit(input.opts.limit),
    }),
  );
}

export function buildProjectListInputFromMcp(input: ProjectListMcpInput): ProjectListInput {
  const limit = input.limit ?? 50;
  return validateProjectListInput(
    parseSurfaceInput("projects.list", projectListCanonicalSchema, {
      team: input.team,
      allTeams: input.all_teams,
      state: input.state,
      includeArchived: input.include_archived,
      cursor: input.cursor,
      max: limit === 0 ? Number.POSITIVE_INFINITY : limit,
    }),
  );
}

export function buildProjectGetInput(id: string): ProjectGetInput {
  return parseSurfaceInput("projects.get", projectGetCanonicalSchema, { id });
}

export function buildProjectCreateInputFromCli(input: ProjectCreateCliInput): ProjectCreateInput {
  const teamKeys = [...(input.opts.teamKey ?? [])];
  if (input.opts.team) teamKeys.push(input.opts.team);
  return parseSurfaceInput("projects.create", projectCreateCanonicalSchema, {
    name: input.name,
    teamIds: input.opts.teamId ?? [],
    teamKeys,
    description: input.opts.description,
    content: input.opts.content,
    icon: input.opts.icon,
    state: input.opts.state,
    startDate: input.opts.startDate,
    targetDate: input.opts.targetDate,
  });
}

export function buildProjectCreateInputFromMcp(input: ProjectCreateMcpInput): ProjectCreateInput {
  const teamKeys = [...(input.team_keys ?? [])];
  if (input.team) teamKeys.push(input.team);
  return parseSurfaceInput("projects.create", projectCreateCanonicalSchema, {
    name: input.name,
    teamIds: input.team_ids ?? [],
    teamKeys,
    description: input.description,
    content: input.content,
    icon: input.icon,
    state: input.state,
    startDate: input.start_date,
    targetDate: input.target_date,
  });
}

export function buildProjectUpdateInputFromCli(
  input: ProjectUpdateCliInput,
): ProjectUpdateCanonicalInput {
  const update: ProjectUpdateInput = {};
  if (input.opts.name !== undefined) update.name = input.opts.name;
  if (input.opts.description !== undefined) update.description = input.opts.description;
  if (input.opts.content !== undefined) update.content = input.opts.content;
  if (input.opts.icon !== undefined)
    update.icon = input.opts.icon === "null" ? null : input.opts.icon;
  if (input.opts.state !== undefined) update.state = input.opts.state;
  if (input.opts.startDate !== undefined) {
    update.startDate = input.opts.startDate === "null" ? null : input.opts.startDate;
  }
  if (input.opts.targetDate !== undefined) {
    update.targetDate = input.opts.targetDate === "null" ? null : input.opts.targetDate;
  }
  return validateProjectUpdateInput({
    id: input.id,
    update,
  });
}

export function buildProjectUpdateInputFromMcp(
  input: ProjectUpdateMcpInput,
): ProjectUpdateCanonicalInput {
  const update: ProjectUpdateInput = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description;
  if (input.content !== undefined) update.content = input.content;
  if (input.icon !== undefined) update.icon = input.icon;
  if (input.state !== undefined) update.state = input.state;
  if (input.start_date !== undefined) update.startDate = input.start_date;
  if (input.target_date !== undefined) update.targetDate = input.target_date;
  return validateProjectUpdateInput({
    id: input.id,
    update,
    repoRoot: input.repo_root,
  });
}

export function buildProjectDeleteInputFromCli(input: ProjectDeleteCliInput): ProjectDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to delete project ${input.id} without --yes`,
      "re-run with --yes to confirm. This operation is irreversible.",
    );
  }
  return parseSurfaceInput("projects.delete", projectDeleteCanonicalSchema, { id: input.id });
}

export function buildProjectDeleteInputFromMcp(input: ProjectDeleteMcpInput): ProjectDeleteInput {
  return parseSurfaceInput("projects.delete", projectDeleteCanonicalSchema, { id: input.id });
}

export async function executeProjectList(
  input: ProjectListInput,
  deps: ProjectListDeps,
): Promise<ProjectListExecutionResult> {
  const teamFilter = input.allTeams ? undefined : await deps.resolveTeam(input.team);
  const common = {
    team: input.allTeams ? "*" : (teamFilter as string),
    teamFilter,
  };
  if (input.max === Number.POSITIVE_INFINITY) {
    const records = await listProjects({
      team: teamFilter,
      state: input.state,
      includeArchived: input.includeArchived,
      max: input.max,
    });
    return {
      ...common,
      records,
      count: records.length,
      limit: 0,
      has_more: false,
      next_cursor: null,
      truncated: false,
    };
  }

  const limit = Math.max(0, Math.floor(input.max));
  if (limit === 0) {
    return {
      ...common,
      records: [],
      count: 0,
      limit: 0,
      has_more: false,
      next_cursor: null,
      truncated: false,
    };
  }

  const records: ListedProject[] = [];
  let after = input.cursor;
  const seenCursors = new Set<string>();
  if (after) seenCursors.add(after);
  let lastPageInfo: { hasNextPage: boolean; endCursor?: string | null } = {
    hasNextPage: false,
    endCursor: null,
  };

  while (records.length < limit) {
    const beforeCount = records.length;
    const page = await listProjectsPage({
      team: teamFilter,
      state: input.state,
      includeArchived: input.includeArchived,
      limit: limit - records.length,
      after,
    });
    records.push(...page.nodes.slice(0, limit - records.length));
    lastPageInfo = page.pageInfo;
    if (!page.pageInfo.hasNextPage || records.length >= limit) break;
    const nextCursor = page.pageInfo.endCursor?.trim();
    if (!nextCursor) {
      throw new ValidationError(
        "project list pagination reported more pages without a continuation cursor",
        "retry later; Linear returned hasNextPage without endCursor",
      );
    }
    if (seenCursors.has(nextCursor)) {
      throw new ValidationError(
        "project list pagination returned a repeated cursor",
        "retry with a smaller limit; Linear returned the same continuation cursor twice",
      );
    }
    if (records.length === beforeCount) {
      throw new ValidationError(
        "project list pagination made no progress",
        "retry later; Linear returned an empty continuation page while reporting more results",
      );
    }
    seenCursors.add(nextCursor);
    after = nextCursor;
  }

  const hasMore = records.length >= limit && lastPageInfo.hasNextPage;
  return {
    ...common,
    records,
    count: records.length,
    limit,
    has_more: hasMore,
    next_cursor: hasMore ? (lastPageInfo.endCursor ?? null) : null,
    truncated: hasMore,
  };
}

export function projectListPayload(result: ProjectListExecutionResult) {
  return {
    team: result.team,
    count: result.count,
    limit: result.limit,
    has_more: result.has_more,
    next_cursor: result.next_cursor,
    truncated: result.truncated,
    projects: result.records,
  };
}

export async function executeProjectGet(
  input: ProjectGetInput,
  hint: string,
): Promise<FullProject> {
  const project = await getProject(input.id);
  if (!project) {
    throw new NotFoundError(`project not found: ${input.id}`, hint);
  }
  return project;
}

export async function resolveProjectCreateTeamIds(
  input: ProjectCreateInput,
  deps: ProjectCreateTeamDeps,
): Promise<string[]> {
  for (const teamId of input.teamIds) {
    if (teamId.trim().length === 0) {
      throw new ValidationError(
        "team_ids cannot contain empty strings",
        "remove empty team_ids entries, or use team/team_keys for team keys",
      );
    }
  }

  const teamIds = [...input.teamIds];
  const teamKeys = [...input.teamKeys];
  if (teamIds.length === 0 && teamKeys.length === 0) {
    teamKeys.push(await deps.defaultTeamKey());
  }
  for (const key of Array.from(new Set(teamKeys))) {
    teamIds.push(await deps.resolveTeamKeyToId(key));
  }
  const unique = [...new Set(teamIds)];
  if (unique.length === 0) {
    throw new ValidationError(
      "create_project requires at least one team",
      "pass team/team_keys/team_ids, or configure a default team",
    );
  }
  return unique;
}

export async function executeProjectCreate(
  input: ProjectCreateInput,
  deps: ProjectCreateTeamDeps,
): Promise<ProjectCreateExecutionResult> {
  const teamIds = await resolveProjectCreateTeamIds(input, deps);
  const project = await createProject({
    name: input.name,
    teamIds,
    description: input.description,
    content: input.content,
    icon: input.icon,
    state: input.state,
    startDate: input.startDate,
    targetDate: input.targetDate,
  });
  return { project, teamIds };
}

export async function executeProjectUpdate(
  input: ProjectUpdateCanonicalInput,
  deps: ProjectUpdateDeps,
): Promise<ProjectUpdateExecutionResult> {
  const project = await updateProject(input.id, input.update);
  const cacheContext = deps.resolveCacheContext?.(input.repoRoot);
  const cache = await deps.refreshCache(project, cacheContext);
  return {
    status: cache.error ? "updated-writeback-failed" : "updated",
    project,
    cache,
  };
}

export async function executeProjectDelete(
  input: ProjectDeleteInput,
): Promise<ProjectDeleteExecutionResult> {
  const result = await tryIdempotentDelete(() => deleteProject(input.id));
  return {
    id: input.id,
    status: result.status,
    success: result.status === "deleted" && Boolean(result.result),
  };
}

export const projectListOperation = {
  id: "projects.list",
  domain: "projects",
  resource: "project",
  action: "list",
  title: "List Linear projects",
  description: "List projects scoped to a team (default) or workspace-wide.",
  cli: { command: "project list" },
  mcp: {
    tool: "list_projects",
    title: "List Linear projects",
    description: "List projects scoped to a team (default) or workspace-wide.",
    annotations: {
      title: "List Linear projects",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildProjectListInputFromCli,
  fromMcp: buildProjectListInputFromMcp,
} satisfies SurfaceOperationContract<
  ProjectListInput,
  ProjectListExecutionResult,
  ProjectListCliInput,
  ProjectListMcpInput
>;

export const projectListAliasOperation = {
  id: "projects.list.alias",
  domain: "projects",
  resource: "project",
  action: "list",
  aliasOf: "projects.list",
  title: "List Linear projects",
  description: "Plural CLI alias for listing projects.",
  cli: { command: "projects" },
  mcp: {
    tool: "list_projects",
    title: "List Linear projects",
    description: "List projects scoped to a team (default) or workspace-wide.",
    annotations: {
      title: "List Linear projects",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildProjectListInputFromCli,
  fromMcp: buildProjectListInputFromMcp,
} satisfies SurfaceOperationContract<
  ProjectListInput,
  ProjectListExecutionResult,
  ProjectListCliInput,
  ProjectListMcpInput
>;

export const projectGetOperation = {
  id: "projects.get",
  domain: "projects",
  resource: "project",
  action: "get",
  title: "Get one project by UUID",
  description:
    "Returns one project (with content + lead + teams). Missing ids surface as structured not_found errors, matching `lebop project view --json`.",
  cli: { command: "project view" },
  mcp: {
    tool: "get_project",
    title: "Get one project by UUID",
    description:
      "Returns one project (with content + lead + teams). Missing ids surface as structured not_found errors, matching `lebop project view --json`.",
    annotations: {
      title: "Get one project by UUID",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
} satisfies SurfaceOperationContract<ProjectGetInput, FullProject>;

export const projectCreateOperation = {
  id: "projects.create",
  domain: "projects",
  resource: "project",
  action: "create",
  title: "Create a project",
  description:
    "Create a project for one or more teams. Accepts team_ids (UUIDs), team_keys, or a single team key; omits selectors to use the configured default team. NOT retry-wrapped (would duplicate).",
  cli: { command: "project create" },
  mcp: {
    tool: "create_project",
    title: "Create a project",
    description:
      "Create a project for one or more teams. Accepts team_ids (UUIDs), team_keys, or a single team key; omits selectors to use the configured default team. NOT retry-wrapped (would duplicate).",
    annotations: {
      title: "Create a project",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  fromCli: buildProjectCreateInputFromCli,
  fromMcp: buildProjectCreateInputFromMcp,
} satisfies SurfaceOperationContract<
  ProjectCreateInput,
  ProjectCreateExecutionResult,
  ProjectCreateCliInput,
  ProjectCreateMcpInput
>;

export const projectUpdateOperation = {
  id: "projects.update",
  domain: "projects",
  resource: "project",
  action: "update",
  title: "Update a project",
  description: "Idempotent at the value level — safe to retry.",
  cli: { command: "project update" },
  mcp: {
    tool: "update_project",
    title: "Update a project",
    description: "Idempotent at the value level — safe to retry.",
    annotations: {
      title: "Update a project",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildProjectUpdateInputFromCli,
  fromMcp: buildProjectUpdateInputFromMcp,
} satisfies SurfaceOperationContract<
  ProjectUpdateCanonicalInput,
  ProjectUpdateExecutionResult,
  ProjectUpdateCliInput,
  ProjectUpdateMcpInput
>;

export const projectDeleteOperation = {
  id: "projects.delete",
  domain: "projects",
  resource: "project",
  action: "delete",
  title: "Delete a project",
  description:
    "Delete a project by UUID. Soft delete server-side (sets `archived_at`); not user-restorable via Linear's standard UI flows. Idempotent — re-deleting an already-soft-deleted project returns `{status: 'already-absent'}`.",
  cli: { command: "project delete" },
  mcp: {
    tool: "delete_project",
    title: "Delete a project",
    description:
      "Delete a project by UUID. Soft delete server-side (sets `archived_at`); not user-restorable via Linear's standard UI flows. Idempotent — re-deleting an already-soft-deleted project returns `{status: 'already-absent'}`.",
    annotations: {
      title: "Delete a project",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildProjectDeleteInputFromCli,
  fromMcp: buildProjectDeleteInputFromMcp,
} satisfies SurfaceOperationContract<
  ProjectDeleteInput,
  ProjectDeleteExecutionResult,
  ProjectDeleteCliInput,
  ProjectDeleteMcpInput
>;

export const PROJECT_SURFACE_OPERATIONS = [
  projectListOperation,
  projectListAliasOperation,
  projectGetOperation,
  projectCreateOperation,
  projectUpdateOperation,
  projectDeleteOperation,
] as const;

export function buildProjectListMcpInputSchema(workspaceDescription: string) {
  return {
    team: teamArg.describe("Team key. Omit to use the configured default team."),
    all_teams: z
      .boolean()
      .optional()
      .describe("Drop the team filter for workspace-wide project listing."),
    state: z.string().optional(),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(0).optional(),
    cursor: z.string().min(1).optional().describe("Continue from a previous next_cursor."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildProjectGetMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildProjectCreateMcpInputSchema(workspaceDescription: string) {
  return {
    name: z.string(),
    team_ids: z.array(z.string()).optional().describe("Team UUIDs."),
    team_keys: z.array(z.string()).optional().describe("Team keys, e.g. ['NOX', 'ENG']."),
    team: teamArg.describe("Single team key convenience selector."),
    description: z.string().optional(),
    content: z.string().optional(),
    icon: z
      .string()
      .optional()
      .describe(
        "Linear internal icon name (PascalCase, e.g. 'BarChart', 'Rocket', 'Target'). Emoji are rejected locally; invalid non-emoji names may be rejected by Linear. Omit if unsure.",
      ),
    state: z.string().optional(),
    start_date: z.string().optional(),
    target_date: z.string().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildProjectUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    content: z.string().optional(),
    icon: z
      .union([z.string(), z.null()])
      .optional()
      .describe(
        "Linear internal icon name, or null to clear. Emoji are rejected locally; invalid non-emoji names may be rejected by Linear.",
      ),
    state: z.string().optional(),
    start_date: z.union([z.string(), z.null()]).optional(),
    target_date: z.union([z.string(), z.null()]).optional(),
    repo_root: repoRootArg.describe(
      "Repo root whose local cache should be refreshed after update.",
    ),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildProjectDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function parseProjectListLimit(value: string | undefined): number {
  return parseCliLimit(value, { defaultValue: 50, zeroMeansInfinity: true });
}

function validateProjectListInput(input: ProjectListInput): ProjectListInput {
  if (input.max === Number.POSITIVE_INFINITY && input.cursor) {
    throw new ValidationError(
      "project list cursor cannot be used with limit 0",
      "pass a positive limit with cursor pagination, or omit cursor to walk all projects",
    );
  }
  return input;
}

function validateProjectUpdateInput(
  input: ProjectUpdateCanonicalInput,
): ProjectUpdateCanonicalInput {
  if (Object.keys(input.update).length === 0) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass at least one of the optional update fields",
    );
  }
  return parseSurfaceInput("projects.update", projectUpdateCanonicalSchema, input);
}
