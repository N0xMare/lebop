import { z } from "zod";
import {
  executePullIssues,
  executePullProject,
  type PullIssueInput,
  type PullProjectInput,
} from "../lib/pullOperations.ts";
import { parseSurfaceInput, repoRootArg, teamArg, workspaceArg } from "./schema.ts";

export { executePullIssues, executePullProject };

export interface PullCliOpts {
  team?: string;
  project?: string;
  projectId?: string;
  refresh?: boolean;
  comments?: boolean;
  to?: string;
}

export interface PullIssuesCliInput {
  ids: string[];
  opts: PullCliOpts;
}

export interface PullProjectCliInput {
  ids: string[];
  opts: PullCliOpts;
}

export type PullIssuesMcpInput = Record<string, unknown> & {
  identifiers: string[];
  repo_root?: string;
  team?: string;
  refresh?: boolean;
  confirm?: boolean;
  include_comments?: boolean;
  to?: string;
  workspace?: string;
};

export type PullProjectMcpInput = Record<string, unknown> & {
  project?: string;
  project_id?: string;
  extra_identifiers?: string[];
  repo_root?: string;
  team?: string;
  refresh?: boolean;
  confirm?: boolean;
  include_comments?: boolean;
  to?: string;
  workspace?: string;
};

const pullIssuesCanonicalSchema = z.object({
  identifiers: z.array(z.string()).min(1),
  repoRoot: repoRootArg,
  team: teamArg,
  refresh: z.boolean().optional(),
  includeComments: z.boolean().optional(),
  to: z.string().optional(),
  deriveTeamFromIdentifiers: z.boolean().optional(),
  requireGitRoot: z.boolean().optional(),
  includeCachePath: z.boolean().optional(),
});

const pullProjectCanonicalSchema = z.object({
  project: z.string().optional(),
  projectId: z.string().optional(),
  extraIdentifiers: z.array(z.string()).optional(),
  repoRoot: repoRootArg,
  team: teamArg,
  refresh: z.boolean().optional(),
  includeComments: z.boolean().optional(),
  to: z.string().optional(),
  requireGitRoot: z.boolean().optional(),
  includeCachePath: z.boolean().optional(),
  strictProjectSelector: z.boolean().optional(),
});

export function buildPullIssuesInputFromCli(input: PullIssuesCliInput): PullIssueInput {
  return parseSurfaceInput("pull.issues", pullIssuesCanonicalSchema, {
    identifiers: input.ids,
    team: input.opts.team,
    refresh: input.opts.refresh === true,
    includeComments: input.opts.comments !== false,
    to: input.opts.to,
    includeCachePath: false,
  });
}

export function buildPullProjectInputFromCli(input: PullProjectCliInput): PullProjectInput {
  return parseSurfaceInput("pull.project", pullProjectCanonicalSchema, {
    project: input.opts.project,
    projectId: input.opts.projectId,
    extraIdentifiers: input.ids,
    team: input.opts.team,
    refresh: input.opts.refresh === true,
    includeComments: input.opts.comments !== false,
    to: input.opts.to,
    includeCachePath: false,
    strictProjectSelector: true,
  });
}

export function buildPullIssuesInputFromMcp(input: PullIssuesMcpInput): PullIssueInput {
  return parseSurfaceInput("pull.issues", pullIssuesCanonicalSchema, {
    identifiers: input.identifiers,
    repoRoot: input.repo_root,
    team: input.team,
    refresh: input.refresh === true,
    includeComments: input.include_comments !== false,
    to: input.to,
    deriveTeamFromIdentifiers: true,
    requireGitRoot: Boolean(input.repo_root),
    includeCachePath: true,
  });
}

export function buildPullProjectInputFromMcp(input: PullProjectMcpInput): PullProjectInput {
  return parseSurfaceInput("pull.project", pullProjectCanonicalSchema, {
    project: input.project,
    projectId: input.project_id,
    extraIdentifiers: input.extra_identifiers,
    repoRoot: input.repo_root,
    team: input.team,
    refresh: input.refresh === true,
    includeComments: input.include_comments !== false,
    to: input.to,
    requireGitRoot: Boolean(input.repo_root),
    includeCachePath: true,
    strictProjectSelector: true,
  });
}

export function buildPullIssuesMcpInputSchema(workspaceParamDescription: string) {
  return {
    identifiers: z
      .array(z.string())
      .min(1)
      .describe("Issue identifiers or CLI-style ranges (TEAM-NN or TEAM-NN..TEAM-MM)."),
    repo_root: repoRootArg,
    team: teamArg,
    refresh: z
      .boolean()
      .optional()
      .describe("Overwrite cached issues that have unpushed local edits."),
    confirm: z
      .boolean()
      .optional()
      .describe("Required true when refresh=true because local cache edits may be overwritten."),
    include_comments: z.boolean().optional().describe("Default true."),
    to: z
      .string()
      .optional()
      .describe(
        "Optional export directory. When set, writes files to to/<id>/ instead of the cache.",
      ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildPullProjectMcpInputSchema(workspaceParamDescription: string) {
  return {
    project: z.string().optional().describe("Project name or UUID."),
    project_id: z.string().optional().describe("Project UUID; skips name lookup."),
    extra_identifiers: z
      .array(z.string())
      .optional()
      .describe("Additional issue identifiers or ranges to pull alongside the project issues."),
    repo_root: repoRootArg,
    team: teamArg,
    refresh: z.boolean().optional().describe("Overwrite cached project/issues with local edits."),
    confirm: z
      .boolean()
      .optional()
      .describe("Required true when refresh=true because local cache edits may be overwritten."),
    include_comments: z.boolean().optional().describe("Default true."),
    to: z
      .string()
      .optional()
      .describe(
        "Optional export directory. When set, writes files to to/project-<uuid>/ and to/<id>/ instead of the cache.",
      ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export const pullIssuesOperation = {
  id: "pull.issues",
  domain: "pull",
  resource: "issues",
  action: "fetch",
  title: "Pull issues",
  description:
    "Fetch issues into local editable cache rows or an export directory. Accepts issue identifiers and ranges.",
  cli: {
    command: "pull",
    liveSteps: ["cli:pull issue --json", "cli:pull --to export --json"],
  },
  mcp: {
    tool: "pull_issues",
    title: "Fetch issues into the local cache",
    description:
      "Pull a set of issues by identifier into ~/.lebop/cache/<repo-hash>/issues/<id>/, or export them to `to/<id>/` when `to` is provided. Accepts CLI-style ranges such as TEAM-1..TEAM-3. Refuses to overwrite cached issues with unpushed local edits unless refresh=true and confirm=true; export mode does not touch the cache.",
    annotations: {
      title: "Fetch issues into the local cache",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: [
      "identifiers",
      "include_comments",
      "confirm",
      "refresh",
      "repo_root",
      "team",
      "to",
      "workspace",
    ],
    liveSemantics: "required",
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  fromCli: buildPullIssuesInputFromCli,
  fromMcp: buildPullIssuesInputFromMcp,
  execute: executePullIssues,
} as const;

export const pullProjectOperation = {
  id: "pull.project",
  domain: "pull",
  resource: "project",
  action: "fetch",
  title: "Pull project",
  description:
    "Fetch a project and child issues into local editable cache rows or an export directory.",
  cli: {
    command: "pull",
    liveSteps: ["cli:pull project --json"],
  },
  mcp: {
    tool: "pull_project",
    title: "Fetch a project and child issues into the local cache",
    description:
      "MCP parity with `lebop pull --project/--project-id`: writes project metadata/content plus all child issues into ~/.lebop/cache, or exports them to `to/` when provided. Refuses to overwrite local cache edits unless refresh=true and confirm=true; export mode does not touch the cache.",
    annotations: {
      title: "Fetch a project and child issues into the local cache",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: [
      "extra_identifiers",
      "include_comments",
      "confirm",
      "project",
      "project_id",
      "refresh",
      "repo_root",
      "team",
      "to",
      "workspace",
    ],
    liveSemantics: "required",
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  fromCli: buildPullProjectInputFromCli,
  fromMcp: buildPullProjectInputFromMcp,
  execute: executePullProject,
} as const;

export const PULL_SURFACE_OPERATIONS = [pullIssuesOperation, pullProjectOperation] as const;
