import { z } from "zod";
import { parseCliLimit } from "../lib/cliOptions.ts";
import { ValidationError } from "../lib/errors.ts";
import {
  type ExploreLinearWorkspaceInput,
  type ExploreLinearWorkspaceResult,
  exploreLinearWorkspace,
} from "../lib/workspaceExplore.ts";
import {
  type FetchDepth,
  type FetchLinearWorkspaceInput,
  type FetchLinearWorkspaceResult,
  fetchLinearWorkspace,
} from "../lib/workspaceFetch.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { boundedInt, parseSurfaceInput, repoRootArg, teamArg, workspaceArg } from "./schema.ts";

const TEAM_FILTERABLE_EXPLORE_KINDS = new Set(["project", "issue", "cycle"]);
export const WORKSPACE_EXPLORE_SEARCH_KIND_INPUTS = [
  "project",
  "projects",
  "issue",
  "issues",
  "initiative",
  "initiatives",
  "document",
  "documents",
  "cycle",
  "cycles",
  "milestone",
  "milestones",
  "agent-session",
  "agent-sessions",
  "agent_session",
  "agent_sessions",
] as const;

const exploreWorkspaceCanonicalSchema = z
  .object({
    path: z.string().optional(),
    query: z.string().optional(),
    team: z.string().optional(),
    kinds: z.array(z.string()).optional(),
    includeArchived: z.boolean().optional(),
    limit: boundedInt(250),
    cursor: z.string().optional(),
  })
  .strict();

const fetchWorkspaceCanonicalSchema = z
  .object({
    target: z.string(),
    include: z.array(z.string()).optional(),
    depth: z.enum(["shallow", "full"]).optional(),
    limit: boundedInt(1000),
    cursor: z.string().optional(),
    repoRoot: repoRootArg,
    to: z.string().optional(),
    workspace: workspaceArg,
  })
  .strict();

export interface WorkspaceExploreCliInput {
  path?: string;
  opts: {
    query?: string;
    team?: string;
    kind?: string[];
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  };
  context?: {
    rootTeam?: string;
  };
}

export interface WorkspaceFetchCliInput {
  target: string;
  opts: {
    include?: string;
    depth?: FetchDepth;
    limit?: number;
    cursor?: string;
    to?: string;
  };
  context?: {
    rootWorkspace?: string;
  };
}

export type WorkspaceExploreMcpInput = Record<string, unknown> & {
  path?: string;
  query?: string;
  team?: string;
  kinds?: string[];
  include_archived?: boolean;
  limit?: number;
  cursor?: string;
};

export type WorkspaceFetchMcpInput = Record<string, unknown> & {
  target: string;
  include?: string[];
  depth?: FetchDepth;
  limit?: number;
  cursor?: string;
  repo_root?: string;
  to?: string;
  workspace?: string;
};

export function buildExploreWorkspaceInputFromCli(
  input: WorkspaceExploreCliInput,
): ExploreLinearWorkspaceInput {
  const rootTeam = input.context?.rootTeam;
  const team =
    input.opts.team ??
    (rootTeam && shouldApplyRootExploreTeam(input.path, input.opts.query, input.opts.kind)
      ? rootTeam
      : undefined);

  return parseSurfaceInput("workspace.explore", exploreWorkspaceCanonicalSchema, {
    path: input.path,
    query: input.opts.query,
    team,
    kinds: input.opts.kind,
    includeArchived: input.opts.includeArchived,
    limit: input.opts.limit,
    cursor: input.opts.cursor,
  });
}

export function buildExploreWorkspaceInputFromMcp(
  input: WorkspaceExploreMcpInput,
): ExploreLinearWorkspaceInput {
  return parseSurfaceInput("workspace.explore", exploreWorkspaceCanonicalSchema, {
    path: input.path,
    query: input.query,
    team: input.team,
    kinds: input.kinds,
    includeArchived: input.include_archived,
    limit: input.limit,
    cursor: input.cursor,
  });
}

export function buildFetchWorkspaceInputFromCli(
  input: WorkspaceFetchCliInput,
): FetchLinearWorkspaceInput {
  return parseSurfaceInput("workspace.fetch", fetchWorkspaceCanonicalSchema, {
    target: input.target,
    include: parseCliIncludeList(input.opts.include),
    depth: input.opts.depth,
    limit: input.opts.limit,
    cursor: input.opts.cursor,
    to: input.opts.to,
    workspace: input.context?.rootWorkspace,
  });
}

export function buildFetchWorkspaceInputFromMcp(
  input: WorkspaceFetchMcpInput,
): FetchLinearWorkspaceInput {
  return parseSurfaceInput("workspace.fetch", fetchWorkspaceCanonicalSchema, {
    target: input.target,
    include: input.include,
    depth: input.depth,
    limit: input.limit,
    cursor: input.cursor,
    repoRoot: input.repo_root,
    to: input.to,
    workspace: input.workspace,
  });
}

export async function executeExploreWorkspace(
  input: ExploreLinearWorkspaceInput,
): Promise<ExploreLinearWorkspaceResult> {
  return exploreLinearWorkspace(input);
}

export async function executeFetchWorkspace(
  input: FetchLinearWorkspaceInput,
): Promise<FetchLinearWorkspaceResult> {
  return fetchLinearWorkspace(input);
}

export const exploreWorkspaceOperation = {
  id: "workspace.explore",
  domain: "workspace",
  resource: "workspace",
  action: "explore",
  title: "Explore Linear workspace context",
  description:
    "Ls-style Linear discovery and search. Returns concise paths, ids, names, states, counts, and next_paths without long bodies.",
  cli: {
    command: "workspace explore",
    liveSteps: [
      "cli:workspace explore root --json",
      "cli:workspace explore projects cursor page 1 --json",
      "cli:workspace explore projects cursor page 2 --json",
      "cli:workspace explore project search --json",
      "cli:workspace explore initiative search --json",
      "cli:workspace explore initiative --json",
      "cli:workspace explore issue --json",
      "cli:workspace explore issue documents --json",
      "cli:workspace explore cycle issues --json",
      "cli:workspace explore project --json",
      "cli:workspace explore project issues --json",
      "cli:workspace explore milestone issues --json",
    ],
  },
  mcp: {
    tool: "explore_linear_workspace",
    title: "Explore Linear workspace context",
    description:
      "Ls-style Linear discovery and search. Returns concise paths, ids, names, states, counts, and next_paths without long bodies.",
    annotations: {
      title: "Explore Linear workspace context",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    liveSemantics: "required",
  },
  safety: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "not_required",
  },
  behaviorContractKind: "explore",
  fromCli: buildExploreWorkspaceInputFromCli,
  fromMcp: buildExploreWorkspaceInputFromMcp,
  execute: executeExploreWorkspace,
} satisfies SurfaceOperationContract<
  ExploreLinearWorkspaceInput,
  ExploreLinearWorkspaceResult,
  WorkspaceExploreCliInput,
  WorkspaceExploreMcpInput
>;

export const fetchWorkspaceOperation = {
  id: "workspace.fetch",
  domain: "workspace",
  resource: "workspace",
  action: "fetch",
  title: "Fetch Linear workspace context",
  description:
    "Materialize a bounded Linear project, issue, initiative, agent session, document, cycle, or milestone dossier into local files and return a compact manifest.",
  cli: {
    command: "workspace fetch",
    liveSteps: [
      "cli:workspace fetch document --json",
      "cli:workspace fetch initiative --json",
      "cli:workspace fetch issue --json",
      "cli:workspace fetch issue documents --json",
      "cli:workspace fetch issue agent-sessions --json",
      "cli:workspace fetch cycle --json",
      "cli:workspace fetch agent-session --json",
      "cli:workspace fetch project --json",
      "cli:workspace fetch milestone --json",
    ],
  },
  mcp: {
    tool: "fetch_linear_workspace",
    title: "Fetch Linear workspace context",
    description:
      "Materialize a bounded Linear project, issue, initiative, agent session, document, cycle, or milestone dossier into local files and return a compact manifest.",
    annotations: {
      title: "Fetch Linear workspace context",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    liveSemantics: "required",
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
    confirm: "not_required",
  },
  behaviorContractKind: "fetch",
  fromCli: buildFetchWorkspaceInputFromCli,
  fromMcp: buildFetchWorkspaceInputFromMcp,
  execute: executeFetchWorkspace,
} satisfies SurfaceOperationContract<
  FetchLinearWorkspaceInput,
  FetchLinearWorkspaceResult,
  WorkspaceFetchCliInput,
  WorkspaceFetchMcpInput
>;

export const WORKSPACE_SURFACE_OPERATIONS = [
  exploreWorkspaceOperation,
  fetchWorkspaceOperation,
] as const;

export function buildExploreWorkspaceMcpInputSchema(workspaceDescription: string) {
  return {
    path: z
      .string()
      .optional()
      .describe("Workspace path. Examples: /, /teams, /projects, /projects/<id>/issues."),
    query: z
      .string()
      .optional()
      .describe(
        "Search workspace context. Issues search all visible teams unless team is supplied.",
      ),
    team: teamArg.describe("Team key for team-scoped listings/search."),
    kinds: z
      .array(z.enum(WORKSPACE_EXPLORE_SEARCH_KIND_INPUTS))
      .optional()
      .describe(
        "Search kinds to include when query is set. Accepts project, issue, initiative, document, cycle, milestone, and agent-session singular/plural forms.",
      ),
    include_archived: z.boolean().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(250)
      .optional()
      .describe(
        "Page size for listings. Search applies this limit per selected kind, so total search items can exceed limit.",
      ),
    cursor: z.string().optional().describe("Continue from a prior result's next_cursor."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildFetchWorkspaceMcpInputSchema(workspaceDescription: string) {
  return {
    target: z
      .string()
      .describe(
        "Concrete workspace path, e.g. /projects/<id>, /issues/NOX-1, /initiatives/<id>, /agent-sessions/<id>, /documents/<id>, /cycles/<id>, or /milestones/<id>.",
      ),
    include: z
      .array(z.string())
      .optional()
      .describe(
        "Includes such as issues, issue_details, comments, relations, attachments, agent_sessions, documents, document_details, issue_documents, issue_document_details, updates, milestones, project_issues, project_documents, project_document_details, project_updates, project_milestones, and content for document targets.",
      ),
    depth: z.enum(["shallow", "full"]).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "Child record limit per collection; nested issue fields use it per parent, and relations use it per direction.",
      ),
    cursor: z
      .string()
      .optional()
      .describe("Continue from a prior fetch_linear_workspace continuation cursor."),
    repo_root: repoRootArg.describe(
      "Repo root whose cache hash should be used for context metadata.",
    ),
    to: z.string().optional().describe("Local output directory. Defaults to ~/.lebop/context."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function parseWorkspaceExploreLimit(value: string): number {
  return parseBoundedPositiveInt(value, 250);
}

export function parseWorkspaceFetchLimit(value: string): number {
  return parseBoundedPositiveInt(value, 1000);
}

export function parseWorkspaceFetchDepth(value: string): FetchDepth {
  if (value === "shallow" || value === "full") return value;
  throw new ValidationError(`depth must be shallow or full, got ${value}`);
}

function parseBoundedPositiveInt(value: string, max: number): number {
  return parseCliLimit(value, { max });
}

function parseCliIncludeList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",");
}

function shouldApplyRootExploreTeam(
  path: string | undefined,
  query: string | undefined,
  kinds: string[] | undefined,
): boolean {
  if (query?.trim()) {
    const normalizedKinds = (kinds ?? []).map(normalizeExploreKind);
    if (normalizedKinds.length > 0) {
      return normalizedKinds.every((kind) => TEAM_FILTERABLE_EXPLORE_KINDS.has(kind));
    }
  }
  const normalizedPath = path?.trim() || "/";
  return (
    ["/projects", "/issues", "/cycles"].includes(normalizedPath) ||
    /^\/teams\/[^/]+\/(projects|issues|cycles)$/.test(normalizedPath)
  );
}

function normalizeExploreKind(kind: string): string {
  const normalized = kind.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "projects") return "project";
  if (normalized === "issues") return "issue";
  if (normalized === "cycles") return "cycle";
  return normalized;
}
