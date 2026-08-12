import { z } from "zod";
import {
  type IssueCacheRefreshResult,
  refreshCachedIssueByIdentifier,
} from "../lib/cacheRefresh.ts";
import { parseCliNumber } from "../lib/cliOptions.ts";
import { ValidationError } from "../lib/errors.ts";
import {
  type CreatedIssue,
  createIssue,
  type FetchedIssue,
  ISSUE_UPDATE_FIELD_HINT,
  type IssueWriteProof,
  issueWriteProof,
  type CreateIssueInput as LibCreateIssueInput,
  type UpdateIssueInput as LibUpdateIssueInput,
  updateIssue,
} from "../lib/issues.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, repoRootArg, teamArg, workspaceArg } from "./schema.ts";

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
  parent?: string;
  milestone?: string;
  cycle?: string;
  dueDate?: string;
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
    parent?: string;
    milestone?: string;
    cycle?: string;
    dueDate?: string;
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
  parent?: string;
  milestone?: string;
  cycle?: string;
  due_date?: string;
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
  dueDate?: string | null;
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
  due_date?: string | null;
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
    parent: z.string().optional(),
    milestone: z.string().optional(),
    cycle: z.string().optional(),
    dueDate: z.string().optional(),
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
    dueDate: z.string().nullable().optional(),
    repoRoot: repoRootArg,
  })
  .strict();

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
    parent: input.opts.parent,
    milestone: input.opts.milestone,
    cycle: input.opts.cycle,
    dueDate: input.opts.dueDate,
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
    parent: input.parent,
    milestone: input.milestone,
    cycle: input.cycle,
    dueDate: input.due_date,
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
      dueDate: input.due_date,
      repoRoot: input.repo_root,
    }),
  );
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
      ISSUE_UPDATE_FIELD_HINT,
    );
  }
  return normalized;
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
    parent: input.parent,
    milestone: input.milestone,
    cycle: input.cycle,
    dueDate: input.dueDate,
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
    dueDate: input.dueDate,
  } satisfies LibUpdateIssueInput);
  const cache = await depsRefreshIssue(cacheContext, issue.identifier, issue);
  return {
    status: issueUpdateMutationStatus(cache),
    issue,
    remote: issueWriteProof(issue),
    cache,
  };
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

export function buildIssueCreateMcpInputSchema(workspaceParamDescription: string) {
  return {
    team: teamArg.describe("Team key (e.g. 'TEAM'). Defaults to repo config."),
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
    parent: z.string().optional().describe("Parent issue identifier."),
    milestone: z.string().optional().describe("Milestone name or UUID (issue project)."),
    cycle: z.string().optional().describe("Cycle name or UUID."),
    due_date: z.string().optional().describe("Due date YYYY-MM-DD or ISO."),
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
      "Team key. Auto-derived from the issue identifier prefix when omitted (e.g. 'TEAM-1' -> 'TEAM'). Pass explicitly only to override the derived team. Required when state/labels/assignee names are passed AND the identifier prefix can't be derived.",
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
    due_date: z
      .string()
      .nullable()
      .optional()
      .describe("Due date YYYY-MM-DD or ISO; null to clear."),
    repo_root: repoRootArg.describe(
      "Repo root whose team-metadata cache and issue cache should be used.",
    ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

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
    profile: "core",
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
    "Set any combination of: title, description, state, priority, estimate, labels, label deltas, assignee, parent, project, milestone, cycle, due_date. Idempotent at the value level — safe to retry.",
  cli: {
    command: "set",
    liveSteps: [
      "cli:set title --json",
      "cli:set state --json",
      "cli:set priority --json",
      "cli:set estimate --json",
      "cli:set assignee --json",
      "cli:set description --json",
      "cli:set due-date --json",
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
    profile: "core",
    title: "Update fields on an existing Linear issue",
    description:
      "Set any combination of: title, description, state, priority, estimate, labels, labels_add/labels_remove deltas, assignee, parent, project, milestone, cycle, due_date. Idempotent at the value level — safe to retry.",
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
