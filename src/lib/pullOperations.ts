import { resolve as resolvePath } from "node:path";
import { buildComments, buildIssueMetadata, buildProjectMetadata } from "./build.ts";
import {
  issueDir,
  projectDir,
  readIssue,
  readProject,
  writeIssueWithComments,
  writeProject,
} from "./cache.ts";
import { resolveConfig } from "./config.ts";
import { diffIssueMetadata, diffProjectMetadata } from "./diff.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { expandIds } from "./expand.ts";
import { paginateRaw } from "./paginate.ts";
import { preparePullExportRoot, writeIssueExport, writeProjectExport } from "./pullExport.ts";
import {
  type FetchedIssue,
  type FetchedProject,
  type HydrateIssuesResult,
  hydrateIssuesBatched,
  PULL_PROJECT_HEADER_QUERY,
  PULL_PROJECT_ISSUES_QUERY,
} from "./pullQuery.ts";
import { deriveTeamFromIdentifiers, resolveProjectIdByName } from "./resolve.ts";
import { withRetry } from "./retry.ts";
import { linear } from "./sdk.ts";
import { isUuid } from "./uuid.ts";

export interface PullIssueInput {
  identifiers: string[];
  repoRoot?: string;
  team?: string;
  refresh?: boolean;
  includeComments?: boolean;
  to?: string;
  deriveTeamFromIdentifiers?: boolean;
  requireGitRoot?: boolean;
  includeCachePath?: boolean;
}

export interface PullProjectInput {
  project?: string;
  projectId?: string;
  extraIdentifiers?: string[];
  repoRoot?: string;
  team?: string;
  refresh?: boolean;
  includeComments?: boolean;
  to?: string;
  requireGitRoot?: boolean;
  includeCachePath?: boolean;
  strictProjectSelector?: boolean;
}

export interface PullIssueResult {
  identifier: string;
  comments: number;
  path: string;
  cache_path?: string | null;
}

export interface PullProjectResult {
  id: string;
  name: string;
  issues: number;
  path: string;
  cache_path?: string | null;
}

export interface PullOperationResult {
  team: string;
  repo_hash: string;
  mode: "cache" | "export";
  project: PullProjectResult | null;
  issues: PullIssueResult[];
  errors: { identifier: string; error: string }[];
  hydration: HydrateIssuesResult["metadata"];
}

export class PullOverwriteConflictError extends ValidationError {
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(
      `refusing to overwrite local edits on: ${conflicts.join(", ")}`,
      "push the modified cache entries first, or pass refresh=true with confirm=true to discard local edits",
    );
    this.conflicts = conflicts;
  }
}

export async function executePullIssues(input: PullIssueInput): Promise<PullOperationResult> {
  const ids = expandIds(input.identifiers);
  if (ids.length === 0) {
    throw new ValidationError(
      "pull_issues requires at least one identifier",
      "pass identifiers like NOX-1 or ranges like NOX-1..NOX-3",
    );
  }

  const teamOverride =
    input.team ??
    (input.deriveTeamFromIdentifiers ? (deriveTeamFromIdentifiers(ids) ?? undefined) : undefined);
  const config = await resolveConfig({
    cwd: input.repoRoot,
    teamOverride,
    requireGitRoot: input.requireGitRoot,
  });
  const destinationRoot = await prepareDestinationRoot(input.to);
  const client = await linear();
  const withComments = input.includeComments !== false;

  const hydrated = await hydrateIssuesBatched(
    (query, variables) => client.client.rawRequest(query, variables),
    ids,
    { withComments },
  );
  const fetched = hydrated.fetched;
  await assertIssueOverwriteAllowed(
    config.repoHash,
    fetched,
    input.refresh === true,
    destinationRoot,
  );
  const issues = await writeFetchedIssues({
    repoHash: config.repoHash,
    fetched,
    destinationRoot,
    withComments,
    includeCachePath: input.includeCachePath === true,
  });

  return {
    team: config.team,
    repo_hash: config.repoHash,
    mode: destinationRoot ? "export" : "cache",
    project: null,
    issues,
    errors: [...hydrated.errors],
    hydration: hydrated.metadata,
  };
}

export async function executePullProject(input: PullProjectInput): Promise<PullOperationResult> {
  if (!input.project && !input.projectId) {
    throw new ValidationError(
      "pull_project requires project or project_id",
      "pass a project name/UUID via project, or a UUID via project_id",
    );
  }
  if (input.strictProjectSelector && input.project && input.projectId) {
    throw new ValidationError(
      "pass exactly one of project or project_id",
      "project_id skips name lookup; project accepts name or UUID",
    );
  }

  const config = await resolveConfig({
    cwd: input.repoRoot,
    teamOverride: input.team,
    requireGitRoot: input.requireGitRoot,
  });
  const destinationRoot = await prepareDestinationRoot(input.to);
  const client = await linear();
  const projectId = await resolvePullProjectId(input.project, input.projectId, config.team);
  const projectPulled = await fetchProjectWithIssueIdentifiers(client, projectId, {
    query: input.project ?? input.projectId ?? projectId,
  });

  await assertProjectOverwriteAllowed(
    config.repoHash,
    projectPulled.project,
    input.refresh === true,
    destinationRoot,
  );

  const issueIds = Array.from(
    new Set([...expandIds(input.extraIdentifiers ?? []), ...projectPulled.added_issue_ids]),
  );
  const withComments = input.includeComments !== false;
  const hydrated =
    issueIds.length > 0
      ? await hydrateIssuesBatched(
          (query, variables) => client.client.rawRequest(query, variables),
          issueIds,
          { withComments },
        )
      : emptyHydration(withComments);
  await assertIssueOverwriteAllowed(
    config.repoHash,
    hydrated.fetched,
    input.refresh === true,
    destinationRoot,
  );

  const issues = await writeFetchedIssues({
    repoHash: config.repoHash,
    fetched: hydrated.fetched,
    destinationRoot,
    withComments,
    includeCachePath: input.includeCachePath === true,
  });
  const project = await writeFetchedProject({
    repoHash: config.repoHash,
    project: projectPulled.project,
    issueCount: projectPulled.added_issue_ids.length,
    destinationRoot,
    includeCachePath: input.includeCachePath === true,
  });

  return {
    team: config.team,
    repo_hash: config.repoHash,
    mode: destinationRoot ? "export" : "cache",
    project,
    issues,
    errors: [...hydrated.errors],
    hydration: hydrated.metadata,
  };
}

async function prepareDestinationRoot(to: string | undefined): Promise<string | null> {
  if (!to) return null;
  const root = resolvePath(to);
  await preparePullExportRoot(root);
  return root;
}

async function resolvePullProjectId(
  project: string | undefined,
  projectId: string | undefined,
  team: string,
): Promise<string> {
  if (projectId) {
    if (!isUuid(projectId)) {
      throw new ValidationError(
        `invalid project_id: ${projectId}`,
        "project_id must be a Linear project UUID; use project for names",
      );
    }
    return projectId;
  }
  if (!project) {
    throw new ValidationError(
      "pull_project requires project or project_id",
      "pass a project name/UUID via project, or a UUID via project_id",
    );
  }
  return resolveProjectIdByName(project, { teamKey: team });
}

async function fetchProjectWithIssueIdentifiers(
  client: Awaited<ReturnType<typeof linear>>,
  projectId: string,
  input: { query: string },
): Promise<{ project: FetchedProject; added_issue_ids: string[] }> {
  const headerResponse = (await withRetry(() =>
    client.client.rawRequest(PULL_PROJECT_HEADER_QUERY, {
      id: projectId,
    }),
  )) as { data: { project: Omit<FetchedProject, "issues"> | null } };
  const header = headerResponse.data.project;
  if (!header) {
    throw new NotFoundError(
      `project not found: ${input.query}`,
      "verify the project name or UUID; run `lebop project list --all-teams` to enumerate",
    );
  }

  type IssuesPage = {
    data: {
      project: {
        issues: {
          nodes: { identifier: string; title?: string }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    };
  };
  const issueNodes = await paginateRaw<{ identifier: string; title?: string }, IssuesPage>(
    ({ first, after }) =>
      client.client.rawRequest(PULL_PROJECT_ISSUES_QUERY, {
        id: projectId,
        first,
        after,
      }) as Promise<IssuesPage>,
    (response) => response.data.project?.issues ?? null,
    { pageSize: 250 },
  );
  return {
    project: { ...header, issues: { nodes: issueNodes } },
    added_issue_ids: issueNodes.map((node) => node.identifier),
  };
}

async function assertProjectOverwriteAllowed(
  repoHash: string,
  project: FetchedProject,
  refresh: boolean,
  destinationRoot: string | null,
): Promise<void> {
  if (refresh || destinationRoot) return;
  const existing = await readProject(repoHash, project.id);
  if (!existing) return;
  const diffs = diffProjectMetadata(existing.metadata, existing.content);
  if (diffs.length > 0) throw new PullOverwriteConflictError([`project/${project.id}`]);
}

async function assertIssueOverwriteAllowed(
  repoHash: string,
  issues: FetchedIssue[],
  refresh: boolean,
  destinationRoot: string | null,
): Promise<void> {
  if (refresh || destinationRoot) return;
  const conflicts: string[] = [];
  for (const issue of issues) {
    const existing = await readIssue(repoHash, issue.identifier);
    if (existing && diffIssueMetadata(existing.metadata, existing.description).length > 0) {
      conflicts.push(issue.identifier);
    }
  }
  if (conflicts.length > 0) throw new PullOverwriteConflictError(conflicts);
}

async function writeFetchedIssues(input: {
  repoHash: string;
  fetched: FetchedIssue[];
  destinationRoot: string | null;
  withComments: boolean;
  includeCachePath: boolean;
}): Promise<PullIssueResult[]> {
  const results: PullIssueResult[] = [];
  for (const issue of input.fetched) {
    const { metadata, description } = buildIssueMetadata(issue);
    const comments = input.withComments ? buildComments(issue) : [];
    const path = input.destinationRoot
      ? await writeIssueExport(
          input.destinationRoot,
          issue.identifier,
          metadata,
          description,
          comments,
        )
      : await writeIssueToCache(
          input.repoHash,
          issue.identifier,
          metadata,
          description,
          comments,
          input.withComments,
        );
    results.push({
      identifier: issue.identifier,
      comments: comments.length,
      path,
      ...(input.includeCachePath ? { cache_path: input.destinationRoot ? null : path } : {}),
    });
  }
  return results;
}

async function writeFetchedProject(input: {
  repoHash: string;
  project: FetchedProject;
  issueCount: number;
  destinationRoot: string | null;
  includeCachePath: boolean;
}): Promise<PullProjectResult> {
  const { metadata, content } = buildProjectMetadata(input.project);
  const path = input.destinationRoot
    ? await writeProjectExport(input.destinationRoot, input.project.id, metadata, content)
    : await writeProjectToCache(input.repoHash, metadata, content);
  return {
    id: input.project.id,
    name: input.project.name,
    issues: input.issueCount,
    path,
    ...(input.includeCachePath ? { cache_path: input.destinationRoot ? null : path } : {}),
  };
}

async function writeIssueToCache(
  repoHash: string,
  identifier: string,
  metadata: Parameters<typeof writeIssueWithComments>[1],
  description: string,
  comments: Parameters<typeof writeIssueWithComments>[3],
  withComments: boolean,
): Promise<string> {
  await writeIssueWithComments(repoHash, metadata, description, comments, {
    refreshComments: withComments,
  });
  return issueDir(repoHash, identifier);
}

async function writeProjectToCache(
  repoHash: string,
  metadata: Parameters<typeof writeProject>[1],
  content: string,
): Promise<string> {
  await writeProject(repoHash, metadata, content);
  return projectDir(repoHash, metadata._server.id);
}

function emptyHydration(withComments: boolean): {
  fetched: FetchedIssue[];
  errors: { identifier: string; error: string }[];
  metadata: HydrateIssuesResult["metadata"];
} {
  return {
    fetched: [],
    errors: [],
    metadata: {
      requested_count: 0,
      fetched_count: 0,
      failed_count: 0,
      batch_size: 0,
      batch_count: 0,
      with_comments: withComments,
      with_relations: false,
      comments_completed: false,
    },
  };
}
