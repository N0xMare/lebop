/**
 * Workspace fetch orchestrator (kind contexts extracted to workspace/*).
 */
import { NotFoundError, ValidationError } from "./errors.ts";
import type { ParsedWorkspacePath } from "./workspacePaths.ts";
import { parseWorkspacePath } from "./workspacePaths.ts";
import type {
  FetchDepth,
  FetchLinearWorkspaceInput,
  FetchLinearWorkspaceResult,
  FetchContinuation,
  FetchCompletenessEntry,
} from "./workspace/fetchTypes.ts";
import {
  currentRepoHash,
  decodeFetchCursor,
  validateExplicitOutputRoot,
  includeSet,
  selectionFor,
  projectDefaults,
  issueDefaults,
  initiativeDefaults,
  normalizeLimit,
  normalizeDepth,
  addWorkspaceToContinuations,
  dedupeContinuations,
  ALLOWED_PROJECT_INCLUDES,
  ALLOWED_ISSUE_INCLUDES,
  ALLOWED_INITIATIVE_INCLUDES,
  ALLOWED_DOCUMENT_INCLUDES,
  ALLOWED_CYCLE_INCLUDES,
  ALLOWED_MILESTONE_INCLUDES,
  DEFAULT_DOCUMENT_INCLUDES,
  DEFAULT_CYCLE_INCLUDES,
  DEFAULT_MILESTONE_INCLUDES,
  normalizeProjectIncludes,
  normalizeDirectIssueIncludes,
  normalizeInitiativeIncludes,
  normalizeIssueCollectionIncludes,
} from "./workspace/fetchShared.ts";
import { fetchProjectContext } from "./workspace/fetchProject.ts";
import { fetchIssueContext } from "./workspace/fetchIssue.ts";
import { fetchAgentSessionContext } from "./workspace/fetchAgentSession.ts";
import { fetchInitiativeContext } from "./workspace/fetchInitiative.ts";
import { fetchDocumentContext } from "./workspace/fetchDocument.ts";
import { fetchCycleContext } from "./workspace/fetchCycle.ts";
import { fetchMilestoneContext } from "./workspace/fetchMilestone.ts";

export type {
  FetchDepth,
  FetchLinearWorkspaceInput,
  FetchLinearWorkspaceResult,
  FetchContinuation,
  FetchCompletenessEntry,
} from "./workspace/fetchTypes.ts";

export async function fetchLinearWorkspace(
  input: FetchLinearWorkspaceInput,
): Promise<FetchLinearWorkspaceResult> {
  const target = input.target.trim();
  if (!target) {
    throw new ValidationError(
      "fetch_linear_workspace requires target",
      "pass a path such as /projects/<id>, /issues/TEAM-1, or /initiatives/<id>",
    );
  }
  validateExplicitOutputRoot(input.to);

  const parsed = parseWorkspacePath(target);
  const cursor = decodeFetchCursor(input.cursor, parsed);
  const config = {
    repoHash: currentRepoHash(input.repoRoot),
  };
  const limit = normalizeLimit(input.limit);
  const depth = normalizeDepth(input.depth);
  const withWorkspace = (result: FetchLinearWorkspaceResult): FetchLinearWorkspaceResult =>
    addWorkspaceToContinuations(result, input.workspace);

  if (parsed.kind === "project" || parsed.kind === "project_child") {
    const include = includeSet(
      input.include,
      projectDefaults(parsed),
      ALLOWED_PROJECT_INCLUDES,
      "project",
    );
    normalizeProjectIncludes(include);
    return withWorkspace(
      await fetchProjectContext({
        target: parsed.path,
        projectId: parsed.id ?? "",
        config,
        include,
        selection: selectionFor(parsed, include),
        depth,
        limit,
        to: input.to,
        workspace: input.workspace,
        cursor,
      }),
    );
  }
  if (parsed.kind === "issue" || parsed.kind === "issue_child") {
    const include = includeSet(
      input.include,
      issueDefaults(parsed),
      ALLOWED_ISSUE_INCLUDES,
      "issue",
    );
    normalizeDirectIssueIncludes(include);
    return withWorkspace(
      await fetchIssueContext({
        target: parsed.path,
        identifier: parsed.id ?? "",
        config,
        include,
        selection: selectionFor(parsed, include),
        limit,
        to: input.to,
        workspace: input.workspace,
        cursor,
      }),
    );
  }
  if (parsed.kind === "initiative" || parsed.kind === "initiative_child") {
    const include = includeSet(
      input.include,
      initiativeDefaults(parsed),
      ALLOWED_INITIATIVE_INCLUDES,
      "initiative",
    );
    normalizeInitiativeIncludes(include);
    return withWorkspace(
      await fetchInitiativeContext({
        target: parsed.path,
        initiativeId: parsed.id ?? "",
        config,
        include,
        selection: selectionFor(parsed, include),
        depth,
        limit,
        to: input.to,
        workspace: input.workspace,
        cursor,
      }),
    );
  }
  if (parsed.kind === "agent_session") {
    return withWorkspace(
      await fetchAgentSessionContext({
        target: parsed.path,
        sessionId: parsed.id ?? "",
        config,
        selection: selectionFor(parsed, new Set()),
        to: input.to,
        cursor,
      }),
    );
  }
  if (parsed.kind === "document") {
    const include = includeSet(
      input.include,
      DEFAULT_DOCUMENT_INCLUDES,
      ALLOWED_DOCUMENT_INCLUDES,
      "document",
    );
    return withWorkspace(
      await fetchDocumentContext({
        target: parsed.path,
        documentId: parsed.id ?? "",
        config,
        include,
        selection: selectionFor(parsed, include),
        to: input.to,
      }),
    );
  }
  if (parsed.kind === "cycle" || parsed.kind === "cycle_child") {
    const include = includeSet(
      input.include,
      DEFAULT_CYCLE_INCLUDES,
      ALLOWED_CYCLE_INCLUDES,
      "cycle",
    );
    normalizeIssueCollectionIncludes(include);
    return withWorkspace(
      await fetchCycleContext({
        target: parsed.path,
        cycleId: parsed.id ?? "",
        config,
        include,
        selection: selectionFor(parsed, include),
        depth,
        limit,
        to: input.to,
        workspace: input.workspace,
        cursor,
      }),
    );
  }
  if (parsed.kind === "milestone" || parsed.kind === "milestone_child") {
    const include = includeSet(
      input.include,
      DEFAULT_MILESTONE_INCLUDES,
      ALLOWED_MILESTONE_INCLUDES,
      "milestone",
    );
    normalizeIssueCollectionIncludes(include);
    return withWorkspace(
      await fetchMilestoneContext({
        target: parsed.path,
        milestoneId: parsed.id ?? "",
        config,
        include,
        selection: selectionFor(parsed, include),
        depth,
        limit,
        to: input.to,
        workspace: input.workspace,
        cursor,
      }),
    );
  }

  throw new ValidationError(
    `fetch_linear_workspace cannot materialize ${parsed.path}`,
    "fetch a concrete /projects/<id>, /issues/<id>, /initiatives/<id>, /agent-sessions/<id>, /documents/<id>, /cycles/<id>, or /milestones/<id> path returned by explore_linear_workspace",
  );
}

