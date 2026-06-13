import { dirname, resolve as resolvePath } from "node:path";
import { getAgentSession, listAgentSessionsPage } from "./agentSessions.ts";
import { listAttachmentsPage } from "./attachments.ts";
import { listCommentsPage } from "./comments.ts";
import { mapLimit } from "./concurrency.ts";
import { findGitRoot, hashRepoRoot } from "./config.ts";
import { getCycle } from "./cycles.ts";
import { getDocument, listDocumentsPage } from "./documents.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import {
  getInitiativeProjectsPage,
  type InitiativeProjectsPage,
  listInitiativeUpdatesPage,
} from "./initiatives.ts";
import { getIssue } from "./issues.ts";
import { type ListedIssue, listIssuesPage } from "./listIssues.ts";
import { getMilestone, listMilestonesPage } from "./milestones.ts";
import type { ConnectionPage } from "./paginate.ts";
import { getProject, listProjectUpdatesPage } from "./projects.ts";
import { type ListedRelationsPage, listRelationsPage } from "./relations.ts";
import {
  type ContextFile,
  markdownJsonBlock,
  writeWorkspaceContext,
} from "./workspaceContextWriter.ts";
import {
  decodeExploreCursor,
  type ExploreCursor,
  encodeExploreCursor,
} from "./workspaceExplore.ts";
import type { ParsedWorkspacePath } from "./workspacePaths.ts";
import { parseWorkspacePath, safeSegment } from "./workspacePaths.ts";

export type FetchDepth = "shallow" | "full";

export interface FetchLinearWorkspaceInput {
  target: string;
  include?: string[];
  depth?: FetchDepth;
  limit?: number;
  to?: string;
  repoRoot?: string;
  workspace?: string;
  cursor?: string;
}

export interface FetchLinearWorkspaceResult {
  target: string;
  kind: string;
  requested_path_kind: string;
  focused_collection: string | null;
  selected_includes: string[];
  root: string;
  manifest_file: string;
  index_file: string;
  summary_file: string;
  counts: Record<string, number>;
  completeness: Record<string, FetchCompletenessEntry>;
  omitted: string[];
  truncated: boolean;
  recommended_reads: string[];
  continuations: FetchContinuation[];
}

export interface FetchContinuation {
  tool: "fetch_linear_workspace" | "explore_linear_workspace";
  reason: string;
  args: Record<string, unknown>;
}

export interface FetchCompletenessEntry {
  returned: number;
  limit: number | null;
  complete: boolean;
  truncated: boolean;
  total_available?: number;
  limit_semantics?: "per_collection" | "per_parent" | "per_direction" | "per_parent_direction";
  reason?: string;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_DEPTH: FetchDepth = "full";
const DEFAULT_PROJECT_INCLUDES = new Set([
  "issues",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "issue_documents",
  "issue_document_details",
  "documents",
  "document_details",
  "updates",
  "milestones",
]);
const DEFAULT_ISSUE_INCLUDES = new Set([
  "comments",
  "relations",
  "attachments",
  "documents",
  "document_details",
]);
const DEFAULT_INITIATIVE_INCLUDES = new Set([
  "projects",
  "project_issues",
  "project_documents",
  "project_document_details",
  "project_updates",
  "project_milestones",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "issue_documents",
  "issue_document_details",
  "updates",
]);
const DEFAULT_DOCUMENT_INCLUDES = new Set(["content"]);
const DEFAULT_CYCLE_INCLUDES = new Set([
  "issues",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "issue_documents",
  "issue_document_details",
]);
const DEFAULT_MILESTONE_INCLUDES = new Set([
  "issues",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "issue_documents",
  "issue_document_details",
]);
const ISSUE_DOSSIER_CONCURRENCY = 6;

const ALLOWED_PROJECT_INCLUDES = new Set([
  "issues",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "agent_sessions",
  "issue_documents",
  "issue_document_details",
  "documents",
  "document_details",
  "updates",
  "milestones",
]);
const ALLOWED_ISSUE_INCLUDES = new Set([
  "comments",
  "relations",
  "attachments",
  "agent_sessions",
  "documents",
  "document_details",
]);
const ALLOWED_INITIATIVE_INCLUDES = new Set([
  "projects",
  "project_issues",
  "project_documents",
  "project_document_details",
  "project_updates",
  "project_milestones",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "agent_sessions",
  "issue_documents",
  "issue_document_details",
  "updates",
]);
const ALLOWED_DOCUMENT_INCLUDES = new Set(["content"]);
const ALLOWED_CYCLE_INCLUDES = new Set([
  "issues",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "agent_sessions",
  "issue_documents",
  "issue_document_details",
]);
const ALLOWED_MILESTONE_INCLUDES = new Set([
  "issues",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "agent_sessions",
  "issue_documents",
  "issue_document_details",
]);

interface FetchSelection {
  requested_path_kind: string;
  focused_collection: string | null;
  selected_includes: string[];
}

export async function fetchLinearWorkspace(
  input: FetchLinearWorkspaceInput,
): Promise<FetchLinearWorkspaceResult> {
  const target = input.target.trim();
  if (!target) {
    throw new ValidationError(
      "fetch_linear_workspace requires target",
      "pass a path such as /projects/<id>, /issues/NOX-1, or /initiatives/<id>",
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

function addWorkspaceToContinuations(
  result: FetchLinearWorkspaceResult,
  workspace: string | undefined,
): FetchLinearWorkspaceResult {
  if (!workspace || result.continuations.length === 0) return result;
  return {
    ...result,
    continuations: addWorkspaceToContinuationList(result.continuations, workspace),
  };
}

function addWorkspaceToContinuationList(
  continuations: FetchContinuation[],
  workspace: string | undefined,
): FetchContinuation[] {
  if (!workspace || continuations.length === 0) return continuations;
  return continuations.map((continuation) => ({
    ...continuation,
    args: { ...continuation.args, workspace },
  }));
}

function decodeFetchCursor(
  cursor: string | undefined,
  parsed: ParsedWorkspacePath,
): ExploreCursor | null {
  if (!cursor) return null;
  const decoded = decodeExploreCursor(cursor);
  if (
    decoded.path !== parsed.path ||
    decoded.query !== null ||
    decoded.kinds !== null ||
    decoded.includeArchived !== false
  ) {
    throw new ValidationError(
      "fetch cursor does not match this request",
      "reuse the cursor with the exact target path returned in a fetch_linear_workspace continuation",
    );
  }
  if (
    parsed.kind !== "project_child" &&
    parsed.kind !== "issue_child" &&
    parsed.kind !== "initiative_child" &&
    parsed.kind !== "cycle_child" &&
    parsed.kind !== "milestone_child"
  ) {
    throw new ValidationError(
      "fetch cursor requires a child collection target",
      "use the exact target path returned in a fetch_linear_workspace continuation, such as /projects/<id>/issues",
    );
  }
  return decoded;
}

function validateExplicitOutputRoot(to: string | undefined): void {
  if (to === undefined) return;
  const trimmed = to.trim();
  const root = resolvePath(trimmed || ".");
  if (trimmed === "" || root === resolvePath(".") || dirname(root) === root) {
    throw new ValidationError(
      `refusing to use root-equivalent workspace context --to path: ${to}`,
      "choose a child directory for --to",
    );
  }
}

function focusedCursorAfter(
  selection: FetchSelection,
  cursor: ExploreCursor | null,
  collection: string,
): string | undefined {
  if (selection.focused_collection !== collection) return undefined;
  return cursor?.cursors.main;
}

function focusedRelationCursors(
  selection: FetchSelection,
  cursor: ExploreCursor | null,
): Record<string, string> | undefined {
  if (selection.focused_collection !== "relations") return undefined;
  return cursor?.cursors;
}

async function fetchProjectContext(input: {
  target: string;
  projectId: string;
  config: { repoHash: string };
  include: Set<string>;
  selection: FetchSelection;
  depth: FetchDepth;
  limit: number;
  to?: string;
  workspace?: string;
  cursor: ExploreCursor | null;
}): Promise<FetchLinearWorkspaceResult> {
  const project = await getProject(input.projectId);
  if (!project)
    throw new NotFoundError(`project not found: ${input.projectId}`, "verify the project UUID");

  const files: ContextFile[] = [];
  const counts: Record<string, number> = { projects: 1 };
  const completeness: Record<string, FetchCompletenessEntry> = {};
  const omitted: string[] = [];
  const nestedContinuations: FetchContinuation[] = [];
  markComplete(completeness, "projects", 1);

  files.push({
    relative: `projects/${safeSegment(project.id)}/project.md`,
    content: renderEntityMarkdown("Project", project.name, project),
  });

  let issues: ListedIssue[] = [];
  let documents: Awaited<ReturnType<typeof listDocumentsPage>>["nodes"] = [];
  let materializedDocumentDetails: NonNullable<Awaited<ReturnType<typeof getDocument>>>[] = [];
  if (input.include.has("issues")) {
    const issuesPage = await materializePages(
      input.limit,
      (after, limit) =>
        listIssuesPage({
          resolvedTeam: undefined,
          allTeams: true,
          projectId: project.id,
          limit,
          after,
        }),
      focusedCursorAfter(input.selection, input.cursor, "issues"),
    );
    issues = issuesPage.nodes;
    counts.issues = issues.length;
    markPageCompleteness(completeness, "issues", issues.length, input.limit, issuesPage.pageInfo);
    files.push({
      relative: `projects/${safeSegment(project.id)}/issues.json`,
      content: `${JSON.stringify(issues, null, 2)}\n`,
    });
    pushPageContinuation(nestedContinuations, {
      key: "issues",
      path: `/projects/${project.id}/issues`,
      limit: input.limit,
      pageInfo: issuesPage.pageInfo,
      reason: "cursor",
      depth: input.depth,
      include: continuationIncludeFor("issues", input.include),
    });
    if (input.depth === "full") {
      await addIssueDossiersConcurrent({
        files,
        counts,
        completeness,
        omitted,
        issues,
        include: input.include,
        limit: input.limit,
        continuations: nestedContinuations,
      });
    }
  } else {
    omitted.push("issues");
  }

  if (input.include.has("documents")) {
    const documentsPage = await materializePages(
      input.limit,
      (after, limit) => listDocumentsPage({ projectId: project.id, limit, after }),
      focusedCursorAfter(input.selection, input.cursor, "documents"),
    );
    documents = documentsPage.nodes;
    counts.documents = documents.length;
    markPageCompleteness(
      completeness,
      "documents",
      documents.length,
      input.limit,
      documentsPage.pageInfo,
    );
    files.push({
      relative: `projects/${safeSegment(project.id)}/documents.json`,
      content: `${JSON.stringify(documents, null, 2)}\n`,
    });
    if (input.depth === "full" && input.include.has("document_details") && documents.length > 0) {
      materializedDocumentDetails = (
        await mapLimit(documents, ISSUE_DOSSIER_CONCURRENCY, async (document) =>
          getDocument(document.id),
        )
      ).filter((document): document is NonNullable<Awaited<ReturnType<typeof getDocument>>> =>
        Boolean(document),
      );
      counts.document_details = materializedDocumentDetails.length;
      completeness.document_details = {
        returned: materializedDocumentDetails.length,
        limit: documents.length,
        complete: materializedDocumentDetails.length === documents.length,
        truncated: materializedDocumentDetails.length !== documents.length,
        limit_semantics: "per_collection",
        ...(materializedDocumentDetails.length === documents.length
          ? {}
          : { reason: "not_available: document_missing" }),
      };
      for (const document of materializedDocumentDetails) {
        files.push({
          relative: `projects/${safeSegment(project.id)}/documents/${safeSegment(document.id)}/document.md`,
          content: renderEntityMarkdown("Document", document.title, document),
        });
      }
    }
    pushPageContinuation(nestedContinuations, {
      key: "documents",
      path: `/projects/${project.id}/documents`,
      limit: input.limit,
      pageInfo: documentsPage.pageInfo,
      reason: "cursor",
      depth: input.depth,
      include: continuationIncludeFor("documents", input.include),
    });
  } else {
    omitted.push("documents");
  }

  if (input.include.has("updates")) {
    const updatesPage = await materializePages(
      input.limit,
      (after, limit) => listProjectUpdatesPage(project.id, { limit, after }),
      focusedCursorAfter(input.selection, input.cursor, "updates"),
    );
    const updates = updatesPage.nodes;
    counts.project_updates = updates.length;
    markPageCompleteness(
      completeness,
      "project_updates",
      updates.length,
      input.limit,
      updatesPage.pageInfo,
    );
    files.push({
      relative: `projects/${safeSegment(project.id)}/updates.md`,
      content: renderListMarkdown("Project updates", updates),
    });
    pushPageContinuation(nestedContinuations, {
      key: "project_updates",
      path: `/projects/${project.id}/updates`,
      limit: input.limit,
      pageInfo: updatesPage.pageInfo,
      reason: "cursor",
      depth: input.depth,
      include: continuationIncludeFor("project_updates", input.include),
    });
  } else {
    omitted.push("updates");
  }

  if (input.include.has("milestones")) {
    const milestonesPage = await materializePages(
      input.limit,
      (after, limit) => listMilestonesPage({ projectId: project.id, limit, after }),
      focusedCursorAfter(input.selection, input.cursor, "milestones"),
    );
    const milestones = milestonesPage.nodes;
    counts.milestones = milestones.length;
    markPageCompleteness(
      completeness,
      "milestones",
      milestones.length,
      input.limit,
      milestonesPage.pageInfo,
    );
    files.push({
      relative: `projects/${safeSegment(project.id)}/milestones.json`,
      content: `${JSON.stringify(milestones, null, 2)}\n`,
    });
    pushPageContinuation(nestedContinuations, {
      key: "milestones",
      path: `/projects/${project.id}/milestones`,
      limit: input.limit,
      pageInfo: milestonesPage.pageInfo,
      reason: "cursor",
      depth: input.depth,
      include: continuationIncludeFor("milestones", input.include),
    });
  } else {
    omitted.push("milestones");
  }

  const truncated = isTruncated(completeness);
  const continuations = addWorkspaceToContinuationList(
    dedupeContinuations([
      ...continuationHints({
        target: input.target,
        kind: "project",
        depth: input.depth,
        limit: input.limit,
        completeness,
        childTargets: {},
      }),
      ...nestedContinuations,
    ]),
    input.workspace,
  );
  const summary = {
    target: input.target,
    kind: "project",
    ...input.selection,
    project,
    counts,
    completeness,
    omitted,
    truncated,
    continuations,
  };
  const reads = recommendedReads([
    `projects/${safeSegment(project.id)}/project.md`,
    input.include.has("issues") ? `projects/${safeSegment(project.id)}/issues.json` : null,
    input.include.has("documents") ? `projects/${safeSegment(project.id)}/documents.json` : null,
    input.depth === "full" &&
    input.include.has("document_details") &&
    materializedDocumentDetails[0]
      ? `projects/${safeSegment(project.id)}/documents/${safeSegment(materializedDocumentDetails[0].id)}/document.md`
      : null,
    input.include.has("updates") ? `projects/${safeSegment(project.id)}/updates.md` : null,
    input.include.has("milestones") ? `projects/${safeSegment(project.id)}/milestones.json` : null,
    issues[0] && input.depth === "full"
      ? `issues/${safeSegment(issues[0].identifier)}/issue.md`
      : null,
    issues[0] && input.depth === "full" && input.include.has("comments")
      ? `issues/${safeSegment(issues[0].identifier)}/comments.md`
      : null,
    issues[0] && input.depth === "full" && input.include.has("issue_documents")
      ? `issues/${safeSegment(issues[0].identifier)}/documents.json`
      : null,
  ]);
  const index = [
    `# Linear project context: ${project.name}`,
    "",
    `Target: ${input.target}`,
    `Project: ${project.id}`,
    `URL: ${project.url}`,
    "",
    "## Counts",
    markdownJsonBlock(counts),
    "## Recommended files",
    "",
    ...recommendedList(reads),
    "",
  ].join("\n");
  const written = await writeWorkspaceContext({
    repoHash: input.config.repoHash,
    target: project.id,
    kind: "project",
    index,
    summary,
    manifest: summary,
    files,
    recommendedReads: reads,
    to: input.to,
  });

  return {
    target: input.target,
    kind: "project",
    ...input.selection,
    counts,
    completeness,
    omitted,
    truncated,
    continuations,
    ...written,
  };
}

async function fetchIssueContext(input: {
  target: string;
  identifier: string;
  config: { repoHash: string };
  include: Set<string>;
  selection: FetchSelection;
  limit: number;
  to?: string;
  workspace?: string;
  cursor: ExploreCursor | null;
}): Promise<FetchLinearWorkspaceResult> {
  const issue = await getIssue(input.identifier);
  if (!issue)
    throw new NotFoundError(`issue not found: ${input.identifier}`, "verify the issue id");

  const files: ContextFile[] = [
    {
      relative: `issues/${safeSegment(issue.identifier)}/issue.md`,
      content: renderEntityMarkdown("Issue", issue.identifier, issue),
    },
  ];
  const counts: Record<string, number> = { issues: 1 };
  const completeness: Record<string, FetchCompletenessEntry> = {};
  const omitted: string[] = [];
  const childContinuations: FetchContinuation[] = [];
  let materializedIssueDocumentDetails: NonNullable<Awaited<ReturnType<typeof getDocument>>>[] = [];
  markComplete(completeness, "issues", 1);

  if (input.include.has("comments")) {
    const page = await materializeCommentPages(
      issue.identifier,
      input.limit,
      focusedCursorAfter(input.selection, input.cursor, "comments"),
    );
    counts.comments = page.comments.length;
    markPageCompleteness(
      completeness,
      "comments",
      page.comments.length,
      input.limit,
      page.pageInfo,
    );
    files.push({
      relative: `issues/${safeSegment(issue.identifier)}/comments.md`,
      content: renderListMarkdown("Comments", page.comments),
    });
    pushPageContinuation(childContinuations, {
      key: "comments",
      path: `/issues/${issue.identifier}/comments`,
      limit: input.limit,
      pageInfo: page.pageInfo,
      reason: "cursor",
      include: continuationIncludeFor("comments", input.include),
    });
  } else {
    omitted.push("comments");
  }

  if (input.include.has("relations")) {
    const relations = await materializeRelationPages(
      issue.identifier,
      input.limit,
      focusedRelationCursors(input.selection, input.cursor),
    );
    counts.relations = relations.outbound.length + relations.inbound.length;
    markRelationCompleteness(completeness, "relations", counts.relations, input.limit, relations);
    files.push({
      relative: `issues/${safeSegment(issue.identifier)}/relations.json`,
      content: `${JSON.stringify(relations, null, 2)}\n`,
    });
    pushRelationContinuation(
      childContinuations,
      "relations",
      `/issues/${issue.identifier}/relations`,
      input.limit,
      relations,
      continuationIncludeFor("relations", input.include),
    );
  } else {
    omitted.push("relations");
  }

  if (input.include.has("attachments")) {
    const page = await materializeAttachmentPages(
      issue.identifier,
      input.limit,
      focusedCursorAfter(input.selection, input.cursor, "attachments"),
    );
    counts.attachments = page.attachments.length;
    markPageCompleteness(
      completeness,
      "attachments",
      page.attachments.length,
      input.limit,
      page.pageInfo,
    );
    files.push({
      relative: `issues/${safeSegment(issue.identifier)}/attachments.json`,
      content: `${JSON.stringify(page.attachments, null, 2)}\n`,
    });
    pushPageContinuation(childContinuations, {
      key: "attachments",
      path: `/issues/${issue.identifier}/attachments`,
      limit: input.limit,
      pageInfo: page.pageInfo,
      reason: "cursor",
      include: continuationIncludeFor("attachments", input.include),
    });
  } else {
    omitted.push("attachments");
  }

  if (input.include.has("documents")) {
    materializedIssueDocumentDetails = await addIssueDocumentFiles({
      files,
      counts,
      completeness,
      continuations: childContinuations,
      issueId: issue.id,
      identifier: issue.identifier,
      prefix: `issues/${safeSegment(issue.identifier)}`,
      limit: input.limit,
      includeDetails: input.include.has("document_details"),
      countKey: "documents",
      detailKey: "document_details",
      aggregate: false,
      after: focusedCursorAfter(input.selection, input.cursor, "documents"),
    });
  } else {
    omitted.push("documents");
  }

  if (input.include.has("agent_sessions")) {
    const agentSessionsAfter = focusedCursorAfter(input.selection, input.cursor, "agent-sessions");
    const sessionsPage = await listAgentSessionsPage({
      issueId: issue.id,
      limit: input.limit,
      ...(agentSessionsAfter ? { after: agentSessionsAfter } : {}),
    });
    const sessions = sessionsPage.nodes;
    counts.agent_sessions = sessions.length;
    markPageCompleteness(
      completeness,
      "agent_sessions",
      sessions.length,
      input.limit,
      sessionsPage.pageInfo,
    );
    files.push({
      relative: `issues/${safeSegment(issue.identifier)}/agent-sessions.json`,
      content: `${JSON.stringify(sessions, null, 2)}\n`,
    });
    pushPageContinuation(childContinuations, {
      key: "agent_sessions",
      path: `/issues/${issue.identifier}/agent-sessions`,
      limit: input.limit,
      pageInfo: sessionsPage.pageInfo,
      reason: "cursor",
      include: continuationIncludeFor("agent_sessions", input.include),
    });
  } else {
    omitted.push("agent_sessions");
  }

  const truncated = isTruncated(completeness);
  const continuations = addWorkspaceToContinuationList(
    dedupeContinuations(childContinuations),
    input.workspace,
  );
  const summary = {
    target: input.target,
    kind: "issue",
    ...input.selection,
    issue,
    counts,
    completeness,
    omitted,
    truncated,
    continuations,
  };
  const reads = recommendedReads([
    `issues/${safeSegment(issue.identifier)}/issue.md`,
    input.include.has("comments") ? `issues/${safeSegment(issue.identifier)}/comments.md` : null,
    input.include.has("relations")
      ? `issues/${safeSegment(issue.identifier)}/relations.json`
      : null,
    input.include.has("attachments")
      ? `issues/${safeSegment(issue.identifier)}/attachments.json`
      : null,
    input.include.has("documents")
      ? `issues/${safeSegment(issue.identifier)}/documents.json`
      : null,
    input.include.has("document_details") && materializedIssueDocumentDetails[0]
      ? `issues/${safeSegment(issue.identifier)}/documents/${safeSegment(materializedIssueDocumentDetails[0].id)}/document.md`
      : null,
    input.include.has("agent_sessions")
      ? `issues/${safeSegment(issue.identifier)}/agent-sessions.json`
      : null,
  ]);
  const index = [
    `# Linear issue context: ${issue.identifier}`,
    "",
    `Title: ${issue.title}`,
    `URL: ${issue.url}`,
    "",
    "## Counts",
    markdownJsonBlock(counts),
    "## Recommended files",
    "",
    ...recommendedList(reads),
    "",
  ].join("\n");
  const written = await writeWorkspaceContext({
    repoHash: input.config.repoHash,
    target: issue.identifier,
    kind: "issue",
    index,
    summary,
    manifest: summary,
    files,
    recommendedReads: reads,
    to: input.to,
  });

  return {
    target: input.target,
    kind: "issue",
    ...input.selection,
    counts,
    completeness,
    omitted,
    truncated,
    continuations,
    ...written,
  };
}

async function fetchAgentSessionContext(input: {
  target: string;
  sessionId: string;
  config: { repoHash: string };
  selection: FetchSelection;
  to?: string;
  cursor: ExploreCursor | null;
}): Promise<FetchLinearWorkspaceResult> {
  const session = await getAgentSession(input.sessionId);
  if (!session)
    throw new NotFoundError(
      `agent session not found: ${input.sessionId}`,
      "verify the agent session UUID",
    );

  const files: ContextFile[] = [
    {
      relative: `agent-sessions/${safeSegment(session.id)}/agent-session.md`,
      content: renderEntityMarkdown("Agent session", session.id, session),
    },
  ];
  const counts: Record<string, number> = { agent_sessions: 1 };
  const completeness: Record<string, FetchCompletenessEntry> = {};
  markComplete(completeness, "agent_sessions", 1);
  const summary = {
    target: input.target,
    kind: "agent_session",
    ...input.selection,
    agent_session: session,
    counts,
    completeness,
    omitted: [],
    truncated: false,
    continuations: [],
  };
  const reads = recommendedReads([`agent-sessions/${safeSegment(session.id)}/agent-session.md`]);
  const index = [
    `# Linear agent session context: ${session.id}`,
    "",
    `Target: ${input.target}`,
    session.issue ? `Issue: ${session.issue.identifier}` : null,
    session.status ? `Status: ${session.status}` : null,
    "",
    "## Recommended files",
    "",
    ...recommendedList(reads),
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  const written = await writeWorkspaceContext({
    repoHash: input.config.repoHash,
    target: session.id,
    kind: "agent_session",
    index,
    summary,
    manifest: summary,
    files,
    recommendedReads: reads,
    to: input.to,
  });

  return {
    target: input.target,
    kind: "agent_session",
    ...input.selection,
    counts,
    completeness,
    omitted: [],
    truncated: false,
    continuations: [],
    ...written,
  };
}

async function fetchInitiativeContext(input: {
  target: string;
  initiativeId: string;
  config: { repoHash: string };
  include: Set<string>;
  selection: FetchSelection;
  depth: FetchDepth;
  limit: number;
  to?: string;
  workspace?: string;
  cursor: ExploreCursor | null;
}): Promise<FetchLinearWorkspaceResult> {
  const initiativePage = input.include.has("projects")
    ? await materializeInitiativeProjectsPage(
        input.initiativeId,
        input.limit,
        focusedCursorAfter(input.selection, input.cursor, "projects"),
      )
    : await materializeInitiativeIdentityPage(input.initiativeId);
  if (!initiativePage)
    throw new NotFoundError(
      `initiative not found: ${input.initiativeId}`,
      "verify the initiative UUID",
    );
  const initiative = initiativePage.initiative;

  const files: ContextFile[] = [
    {
      relative: `initiatives/${safeSegment(initiative.id)}/initiative.md`,
      content: renderEntityMarkdown("Initiative", initiative.name, initiative),
    },
  ];
  const counts: Record<string, number> = { initiatives: 1 };
  const completeness: Record<string, FetchCompletenessEntry> = {};
  const omitted: string[] = [];
  const nestedContinuations: FetchContinuation[] = [];
  markComplete(completeness, "initiatives", 1);

  if (input.include.has("projects")) {
    const projects = initiativePage.projects.nodes;
    counts.projects = projects.length;
    markPageCompleteness(
      completeness,
      "projects",
      projects.length,
      input.limit,
      initiativePage.projects.pageInfo,
    );
    files.push({
      relative: `initiatives/${safeSegment(initiative.id)}/projects.json`,
      content: `${JSON.stringify(projects, null, 2)}\n`,
    });
    pushPageContinuation(nestedContinuations, {
      key: "projects",
      path: `/initiatives/${initiative.id}/projects`,
      limit: input.limit,
      pageInfo: initiativePage.projects.pageInfo,
      reason: "cursor",
      depth: input.depth,
      include: continuationIncludeFor("projects", input.include),
    });
    if (input.depth === "full") {
      const projectDossiers = await mapLimit(projects, ISSUE_DOSSIER_CONCURRENCY, async (p) => {
        const project = await getProject(p.id);
        if (!project) return null;
        const localFiles: ContextFile[] = [
          {
            relative: `projects/${safeSegment(project.id)}/project.md`,
            content: renderEntityMarkdown("Project", project.name, project),
          },
        ];
        const localCounts: Record<string, number> = {};
        const localCompleteness: Record<string, FetchCompletenessEntry> = {};
        const localOmitted: string[] = [];
        const localContinuations: FetchContinuation[] = [];
        if (input.include.has("project_issues")) {
          const projectIssuesPage = await materializePages(input.limit, (after, limit) =>
            listIssuesPage({
              resolvedTeam: undefined,
              allTeams: true,
              projectId: project.id,
              limit,
              after,
            }),
          );
          const projectIssues = projectIssuesPage.nodes;
          localCounts.project_issues = projectIssues.length;
          markPageCompletenessAggregate(
            localCompleteness,
            "project_issues",
            projectIssues.length,
            input.limit,
            "per_parent",
            projectIssuesPage.pageInfo,
          );
          localFiles.push({
            relative: `projects/${safeSegment(project.id)}/issues.json`,
            content: `${JSON.stringify(projectIssues, null, 2)}\n`,
          });
          pushPageContinuation(localContinuations, {
            key: "project_issues",
            path: `/projects/${project.id}/issues`,
            limit: input.limit,
            pageInfo: projectIssuesPage.pageInfo,
            reason: "cursor",
            include: continuationIncludeFor("project_issues", input.include),
          });
          await addIssueDossiersConcurrent({
            files: localFiles,
            counts: localCounts,
            completeness: localCompleteness,
            omitted: localOmitted,
            issues: projectIssues,
            include: input.include,
            limit: input.limit,
            continuations: localContinuations,
          });
        }
        if (input.include.has("project_documents")) {
          const documentsPage = await materializePages(input.limit, (after, limit) =>
            listDocumentsPage({ projectId: project.id, limit, after }),
          );
          const documents = documentsPage.nodes;
          localCounts.project_documents = documents.length;
          markPageCompletenessAggregate(
            localCompleteness,
            "project_documents",
            documents.length,
            input.limit,
            "per_parent",
            documentsPage.pageInfo,
          );
          localFiles.push({
            relative: `projects/${safeSegment(project.id)}/documents.json`,
            content: `${JSON.stringify(documents, null, 2)}\n`,
          });
          pushPageContinuation(localContinuations, {
            key: "project_documents",
            path: `/projects/${project.id}/documents`,
            limit: input.limit,
            pageInfo: documentsPage.pageInfo,
            reason: "cursor",
            depth: input.depth,
            include: continuationIncludeFor("project_documents", input.include),
          });
          if (input.include.has("project_document_details") && documents.length > 0) {
            const materializedDocumentDetails = (
              await mapLimit(documents, ISSUE_DOSSIER_CONCURRENCY, async (document) =>
                getDocument(document.id),
              )
            ).filter((document): document is NonNullable<Awaited<ReturnType<typeof getDocument>>> =>
              Boolean(document),
            );
            localCounts.project_document_details = materializedDocumentDetails.length;
            markDocumentDetailsCompleteness(
              localCompleteness,
              "project_document_details",
              materializedDocumentDetails.length,
              documents.length,
              true,
            );
            for (const document of materializedDocumentDetails) {
              localFiles.push({
                relative: `projects/${safeSegment(project.id)}/documents/${safeSegment(document.id)}/document.md`,
                content: renderEntityMarkdown("Document", document.title, document),
              });
            }
          }
        }
        if (input.include.has("project_updates")) {
          const updatesPage = await materializePages(input.limit, (after, limit) =>
            listProjectUpdatesPage(project.id, { limit, after }),
          );
          const updates = updatesPage.nodes;
          localCounts.project_updates = updates.length;
          markPageCompletenessAggregate(
            localCompleteness,
            "project_updates",
            updates.length,
            input.limit,
            "per_parent",
            updatesPage.pageInfo,
          );
          localFiles.push({
            relative: `projects/${safeSegment(project.id)}/updates.md`,
            content: renderListMarkdown("Project updates", updates),
          });
          pushPageContinuation(localContinuations, {
            key: "project_updates",
            path: `/projects/${project.id}/updates`,
            limit: input.limit,
            pageInfo: updatesPage.pageInfo,
            reason: "cursor",
            depth: input.depth,
            include: continuationIncludeFor("project_updates", input.include),
          });
        }
        if (input.include.has("project_milestones")) {
          const milestonesPage = await materializePages(input.limit, (after, limit) =>
            listMilestonesPage({ projectId: project.id, limit, after }),
          );
          const milestones = milestonesPage.nodes;
          localCounts.project_milestones = milestones.length;
          markPageCompletenessAggregate(
            localCompleteness,
            "project_milestones",
            milestones.length,
            input.limit,
            "per_parent",
            milestonesPage.pageInfo,
          );
          localFiles.push({
            relative: `projects/${safeSegment(project.id)}/milestones.json`,
            content: `${JSON.stringify(milestones, null, 2)}\n`,
          });
          pushPageContinuation(localContinuations, {
            key: "project_milestones",
            path: `/projects/${project.id}/milestones`,
            limit: input.limit,
            pageInfo: milestonesPage.pageInfo,
            reason: "cursor",
            depth: input.depth,
            include: continuationIncludeFor("project_milestones", input.include),
          });
        }
        return {
          files: localFiles,
          counts: localCounts,
          completeness: localCompleteness,
          omitted: localOmitted,
          continuations: localContinuations,
        };
      });
      for (const dossier of projectDossiers) {
        if (!dossier) continue;
        mergeFetchCollection(files, counts, completeness, omitted, nestedContinuations, dossier);
      }
    }
  } else {
    omitted.push("projects");
  }

  if (input.include.has("updates")) {
    const updatesPage = await materializePages(
      input.limit,
      (after, limit) => listInitiativeUpdatesPage(initiative.id, { limit, after }),
      focusedCursorAfter(input.selection, input.cursor, "updates"),
    );
    const updates = updatesPage.nodes;
    counts.initiative_updates = updates.length;
    markPageCompleteness(
      completeness,
      "initiative_updates",
      updates.length,
      input.limit,
      updatesPage.pageInfo,
    );
    files.push({
      relative: `initiatives/${safeSegment(initiative.id)}/updates.md`,
      content: renderListMarkdown("Initiative updates", updates),
    });
    pushPageContinuation(nestedContinuations, {
      key: "initiative_updates",
      path: `/initiatives/${initiative.id}/updates`,
      limit: input.limit,
      pageInfo: updatesPage.pageInfo,
      reason: "cursor",
      include: continuationIncludeFor("initiative_updates", input.include),
    });
  } else {
    omitted.push("updates");
  }

  const truncated = isTruncated(completeness);
  const continuations = addWorkspaceToContinuationList(
    dedupeContinuations([
      ...continuationHints({
        target: input.target,
        kind: "initiative",
        depth: input.depth,
        limit: input.limit,
        completeness,
        childTargets: {},
      }),
      ...nestedContinuations,
    ]),
    input.workspace,
  );
  const summary = {
    target: input.target,
    kind: "initiative",
    ...input.selection,
    initiative,
    counts,
    completeness,
    omitted,
    truncated,
    continuations,
  };
  const reads = recommendedReads([
    `initiatives/${safeSegment(initiative.id)}/initiative.md`,
    input.include.has("projects")
      ? `initiatives/${safeSegment(initiative.id)}/projects.json`
      : null,
    input.include.has("updates") ? `initiatives/${safeSegment(initiative.id)}/updates.md` : null,
    input.include.has("projects") && input.depth === "full" && initiativePage.projects.nodes[0]
      ? `projects/${safeSegment(initiativePage.projects.nodes[0].id)}/project.md`
      : null,
    input.include.has("project_documents") &&
    input.depth === "full" &&
    initiativePage.projects.nodes[0]
      ? `projects/${safeSegment(initiativePage.projects.nodes[0].id)}/documents.json`
      : null,
    input.include.has("project_updates") &&
    input.depth === "full" &&
    initiativePage.projects.nodes[0]
      ? `projects/${safeSegment(initiativePage.projects.nodes[0].id)}/updates.md`
      : null,
    input.include.has("project_milestones") &&
    input.depth === "full" &&
    initiativePage.projects.nodes[0]
      ? `projects/${safeSegment(initiativePage.projects.nodes[0].id)}/milestones.json`
      : null,
  ]);
  const index = [
    `# Linear initiative context: ${initiative.name}`,
    "",
    `Target: ${input.target}`,
    `Initiative: ${initiative.id}`,
    `URL: ${initiative.url}`,
    "",
    "## Counts",
    markdownJsonBlock(counts),
    "## Recommended files",
    "",
    ...recommendedList(reads),
    "",
  ].join("\n");
  const written = await writeWorkspaceContext({
    repoHash: input.config.repoHash,
    target: initiative.id,
    kind: "initiative",
    index,
    summary,
    manifest: summary,
    files,
    recommendedReads: reads,
    to: input.to,
  });

  return {
    target: input.target,
    kind: "initiative",
    ...input.selection,
    counts,
    completeness,
    omitted,
    truncated,
    continuations,
    ...written,
  };
}

async function fetchDocumentContext(input: {
  target: string;
  documentId: string;
  config: { repoHash: string };
  include: Set<string>;
  selection: FetchSelection;
  to?: string;
}): Promise<FetchLinearWorkspaceResult> {
  const document = await getDocument(input.documentId);
  if (!document)
    throw new NotFoundError(`document not found: ${input.documentId}`, "verify the document UUID");

  const includeContent = input.include.has("content");
  const documentForOutput = includeContent ? document : omitDocumentContent(document);
  const files: ContextFile[] = [
    {
      relative: `documents/${safeSegment(document.id)}/document.md`,
      content: renderEntityMarkdown("Document", document.title, documentForOutput),
    },
  ];
  const counts: Record<string, number> = { documents: 1 };
  const completeness: Record<string, FetchCompletenessEntry> = {};
  const omitted: string[] = [];
  markComplete(completeness, "documents", 1);
  if (!input.include.has("content")) omitted.push("content");

  const summary = {
    target: input.target,
    kind: "document",
    ...input.selection,
    document: documentForOutput,
    counts,
    completeness,
    omitted,
    truncated: false,
    continuations: [],
  };
  const reads = recommendedReads([`documents/${safeSegment(document.id)}/document.md`]);
  const index = [
    `# Linear document context: ${document.title}`,
    "",
    `Target: ${input.target}`,
    `Document: ${document.id}`,
    `URL: ${document.url}`,
    "",
    "## Recommended files",
    "",
    ...recommendedList(reads),
    "",
  ].join("\n");
  const written = await writeWorkspaceContext({
    repoHash: input.config.repoHash,
    target: document.id,
    kind: "document",
    index,
    summary,
    manifest: summary,
    files,
    recommendedReads: reads,
    to: input.to,
  });

  return {
    target: input.target,
    kind: "document",
    ...input.selection,
    counts,
    completeness,
    omitted,
    truncated: false,
    continuations: [],
    ...written,
  };
}

async function fetchCycleContext(input: {
  target: string;
  cycleId: string;
  config: { repoHash: string };
  include: Set<string>;
  selection: FetchSelection;
  depth: FetchDepth;
  limit: number;
  to?: string;
  workspace?: string;
  cursor: ExploreCursor | null;
}): Promise<FetchLinearWorkspaceResult> {
  const cycle = await getCycle(input.cycleId);
  if (!cycle) throw new NotFoundError(`cycle not found: ${input.cycleId}`, "verify the cycle UUID");

  const files: ContextFile[] = [
    {
      relative: `cycles/${safeSegment(cycle.id)}/cycle.md`,
      content: renderEntityMarkdown("Cycle", cycle.name ?? `Cycle ${cycle.number}`, cycle),
    },
  ];
  const counts: Record<string, number> = { cycles: 1 };
  const completeness: Record<string, FetchCompletenessEntry> = {};
  const omitted: string[] = [];
  const nestedContinuations: FetchContinuation[] = [];
  let issues: ListedIssue[] = [];
  markComplete(completeness, "cycles", 1);

  if (input.include.has("issues")) {
    const issuesPage = await materializePages(
      input.limit,
      (after, limit) =>
        listIssuesPage({
          resolvedTeam: cycle.team.key,
          team: cycle.team.key,
          cycle: cycle.id,
          limit,
          after,
        }),
      focusedCursorAfter(input.selection, input.cursor, "issues"),
    );
    issues = issuesPage.nodes;
    counts.issues = issues.length;
    markPageCompleteness(completeness, "issues", issues.length, input.limit, issuesPage.pageInfo);
    files.push({
      relative: `cycles/${safeSegment(cycle.id)}/issues.json`,
      content: `${JSON.stringify(issues, null, 2)}\n`,
    });
    pushPageContinuation(nestedContinuations, {
      key: "issues",
      path: `/cycles/${cycle.id}/issues`,
      limit: input.limit,
      pageInfo: issuesPage.pageInfo,
      reason: "cursor",
      depth: input.depth,
      include: continuationIncludeFor("issues", input.include),
    });
    if (input.depth === "full") {
      await addIssueDossiersConcurrent({
        files,
        counts,
        completeness,
        omitted,
        issues,
        include: input.include,
        limit: input.limit,
        continuations: nestedContinuations,
      });
    }
  } else {
    omitted.push("issues");
  }

  const truncated = isTruncated(completeness);
  const continuations = addWorkspaceToContinuationList(
    dedupeContinuations([
      ...continuationHints({
        target: input.target,
        kind: "cycle",
        limit: input.limit,
        completeness,
        childTargets: {},
      }),
      ...nestedContinuations,
    ]),
    input.workspace,
  );
  const summary = {
    target: input.target,
    kind: "cycle",
    ...input.selection,
    cycle,
    counts,
    completeness,
    omitted,
    truncated,
    continuations,
  };
  const reads = recommendedReads([
    `cycles/${safeSegment(cycle.id)}/cycle.md`,
    input.include.has("issues") ? `cycles/${safeSegment(cycle.id)}/issues.json` : null,
    issues[0] && input.depth === "full"
      ? `issues/${safeSegment(issues[0].identifier)}/issue.md`
      : null,
    issues[0] && input.depth === "full" && input.include.has("issue_documents")
      ? `issues/${safeSegment(issues[0].identifier)}/documents.json`
      : null,
  ]);
  const index = [
    `# Linear cycle context: ${cycle.name ?? `Cycle ${cycle.number}`}`,
    "",
    `Target: ${input.target}`,
    `Cycle: ${cycle.id}`,
    `Team: ${cycle.team.key}`,
    "",
    "## Counts",
    markdownJsonBlock(counts),
    "## Recommended files",
    "",
    ...recommendedList(reads),
    "",
  ].join("\n");
  const written = await writeWorkspaceContext({
    repoHash: input.config.repoHash,
    target: cycle.id,
    kind: "cycle",
    index,
    summary,
    manifest: summary,
    files,
    recommendedReads: reads,
    to: input.to,
  });

  return {
    target: input.target,
    kind: "cycle",
    ...input.selection,
    counts,
    completeness,
    omitted,
    truncated,
    continuations,
    ...written,
  };
}

async function fetchMilestoneContext(input: {
  target: string;
  milestoneId: string;
  config: { repoHash: string };
  include: Set<string>;
  selection: FetchSelection;
  depth: FetchDepth;
  limit: number;
  to?: string;
  workspace?: string;
  cursor: ExploreCursor | null;
}): Promise<FetchLinearWorkspaceResult> {
  const milestone = await getMilestone(input.milestoneId);
  if (!milestone)
    throw new NotFoundError(
      `milestone not found: ${input.milestoneId}`,
      "verify the milestone UUID",
    );

  const files: ContextFile[] = [
    {
      relative: `milestones/${safeSegment(milestone.id)}/milestone.md`,
      content: renderEntityMarkdown("Milestone", milestone.name, milestone),
    },
  ];
  const counts: Record<string, number> = { milestones: 1 };
  const completeness: Record<string, FetchCompletenessEntry> = {};
  const omitted: string[] = [];
  const nestedContinuations: FetchContinuation[] = [];
  let issues: ListedIssue[] = [];
  markComplete(completeness, "milestones", 1);

  if (input.include.has("issues")) {
    const issuesPage = await materializePages(
      input.limit,
      (after, limit) =>
        listIssuesPage({
          resolvedTeam: undefined,
          allTeams: true,
          milestone: milestone.id,
          limit,
          after,
        }),
      focusedCursorAfter(input.selection, input.cursor, "issues"),
    );
    issues = issuesPage.nodes;
    counts.issues = issues.length;
    markPageCompleteness(completeness, "issues", issues.length, input.limit, issuesPage.pageInfo);
    files.push({
      relative: `milestones/${safeSegment(milestone.id)}/issues.json`,
      content: `${JSON.stringify(issues, null, 2)}\n`,
    });
    pushPageContinuation(nestedContinuations, {
      key: "issues",
      path: `/milestones/${milestone.id}/issues`,
      limit: input.limit,
      pageInfo: issuesPage.pageInfo,
      reason: "cursor",
      depth: input.depth,
      include: continuationIncludeFor("issues", input.include),
    });
    if (input.depth === "full") {
      await addIssueDossiersConcurrent({
        files,
        counts,
        completeness,
        omitted,
        issues,
        include: input.include,
        limit: input.limit,
        continuations: nestedContinuations,
      });
    }
  } else {
    omitted.push("issues");
  }

  const truncated = isTruncated(completeness);
  const continuations = addWorkspaceToContinuationList(
    dedupeContinuations([
      ...continuationHints({
        target: input.target,
        kind: "milestone",
        limit: input.limit,
        completeness,
        childTargets: {},
      }),
      ...nestedContinuations,
    ]),
    input.workspace,
  );
  const summary = {
    target: input.target,
    kind: "milestone",
    ...input.selection,
    milestone,
    counts,
    completeness,
    omitted,
    truncated,
    continuations,
  };
  const reads = recommendedReads([
    `milestones/${safeSegment(milestone.id)}/milestone.md`,
    input.include.has("issues") ? `milestones/${safeSegment(milestone.id)}/issues.json` : null,
    issues[0] && input.depth === "full"
      ? `issues/${safeSegment(issues[0].identifier)}/issue.md`
      : null,
    issues[0] && input.depth === "full" && input.include.has("issue_documents")
      ? `issues/${safeSegment(issues[0].identifier)}/documents.json`
      : null,
  ]);
  const index = [
    `# Linear milestone context: ${milestone.name}`,
    "",
    `Target: ${input.target}`,
    `Milestone: ${milestone.id}`,
    "",
    "## Counts",
    markdownJsonBlock(counts),
    "## Recommended files",
    "",
    ...recommendedList(reads),
    "",
  ].join("\n");
  const written = await writeWorkspaceContext({
    repoHash: input.config.repoHash,
    target: milestone.id,
    kind: "milestone",
    index,
    summary,
    manifest: summary,
    files,
    recommendedReads: reads,
    to: input.to,
  });

  return {
    target: input.target,
    kind: "milestone",
    ...input.selection,
    counts,
    completeness,
    omitted,
    truncated,
    continuations,
    ...written,
  };
}

async function materializePages<T>(
  limit: number,
  fetchPage: (after: string | undefined, limit: number) => Promise<ConnectionPage<T>>,
  initialAfter?: string,
): Promise<ConnectionPage<T>> {
  const nodes: T[] = [];
  let after = initialAfter;
  let pageInfo: ConnectionPage<T>["pageInfo"] = { hasNextPage: false, endCursor: null };
  const seenCursors = new Set<string>();
  if (initialAfter) seenCursors.add(initialAfter);

  while (nodes.length < limit) {
    const remaining = limit - nodes.length;
    const page = await fetchPage(after, remaining);
    const added = page.nodes.slice(0, remaining);
    nodes.push(...added);
    pageInfo = page.pageInfo;
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor) {
      throw new ValidationError(
        "paginated workspace fetch cannot continue",
        "Linear returned hasNextPage without endCursor",
      );
    }
    if (seenCursors.has(pageInfo.endCursor)) {
      throw new ValidationError(
        "paginated workspace fetch cursor did not advance",
        "Linear returned a repeated endCursor while more pages were advertised",
      );
    }
    if (added.length === 0) {
      throw new ValidationError(
        "paginated workspace fetch made no progress",
        "Linear returned hasNextPage but no records for the requested page",
      );
    }
    seenCursors.add(pageInfo.endCursor);
    after = pageInfo.endCursor;
  }

  return { nodes, pageInfo };
}

async function materializeCommentPages(
  identifier: string,
  limit: number,
  after?: string,
): Promise<Awaited<ReturnType<typeof listCommentsPage>>> {
  const page = await materializePages(
    limit,
    async (after, pageLimit) => {
      const comments = await listCommentsPage(identifier, { first: pageLimit, after });
      return { nodes: comments.comments, pageInfo: comments.pageInfo };
    },
    after,
  );
  return { comments: page.nodes, pageInfo: page.pageInfo };
}

async function materializeAttachmentPages(
  identifier: string,
  limit: number,
  after?: string,
): Promise<Awaited<ReturnType<typeof listAttachmentsPage>>> {
  const page = await materializePages(
    limit,
    async (after, pageLimit) => {
      const attachments = await listAttachmentsPage(identifier, { first: pageLimit, after });
      return { nodes: attachments.attachments, pageInfo: attachments.pageInfo };
    },
    after,
  );
  return { attachments: page.nodes, pageInfo: page.pageInfo };
}

async function materializeRelationPages(
  identifier: string,
  limit: number,
  cursors?: Record<string, string>,
): Promise<ListedRelationsPage> {
  const outbound: ListedRelationsPage["outbound"] = [];
  const inbound: ListedRelationsPage["inbound"] = [];
  let outboundAfter = cursors?.outbound;
  let inboundAfter = cursors?.inbound;
  let outboundDone = Boolean(cursors && !cursors.outbound);
  let inboundDone = Boolean(cursors && !cursors.inbound);
  const outboundCursors = new Set<string>();
  const inboundCursors = new Set<string>();
  if (outboundAfter) outboundCursors.add(outboundAfter);
  if (inboundAfter) inboundCursors.add(inboundAfter);
  const pageInfo: ListedRelationsPage["pageInfo"] = {
    outbound: { hasNextPage: false, endCursor: null },
    inbound: { hasNextPage: false, endCursor: null },
  };

  while ((!outboundDone && outbound.length < limit) || (!inboundDone && inbound.length < limit)) {
    const outboundActive = !outboundDone && outbound.length < limit;
    const inboundActive = !inboundDone && inbound.length < limit;
    const pageLimit = Math.max(
      1,
      Math.min(
        outboundActive ? limit - outbound.length : Number.POSITIVE_INFINITY,
        inboundActive ? limit - inbound.length : Number.POSITIVE_INFINITY,
      ),
    );
    const page = await listRelationsPage(identifier, {
      first: pageLimit,
      ...(outboundActive ? { outboundAfter, includeOutbound: true } : { includeOutbound: false }),
      ...(inboundActive ? { inboundAfter, includeInbound: true } : { includeInbound: false }),
    });
    if (page.issueMissing) return page;

    if (outboundActive) {
      const added = page.outbound.slice(0, limit - outbound.length);
      outbound.push(...added);
      assertRelationSideCanContinue(
        identifier,
        "outbound",
        page.pageInfo.outbound,
        outboundCursors,
        added.length,
      );
      pageInfo.outbound = page.pageInfo.outbound;
      outboundDone = !pageInfo.outbound.hasNextPage || outbound.length >= limit;
      outboundAfter = pageInfo.outbound.endCursor ?? outboundAfter;
    }

    if (inboundActive) {
      const added = page.inbound.slice(0, limit - inbound.length);
      inbound.push(...added);
      assertRelationSideCanContinue(
        identifier,
        "inbound",
        page.pageInfo.inbound,
        inboundCursors,
        added.length,
      );
      pageInfo.inbound = page.pageInfo.inbound;
      inboundDone = !pageInfo.inbound.hasNextPage || inbound.length >= limit;
      inboundAfter = pageInfo.inbound.endCursor ?? inboundAfter;
    }
  }

  return {
    outbound,
    inbound,
    complete: !pageInfo.outbound.hasNextPage && !pageInfo.inbound.hasNextPage,
    pageInfo,
  };
}

function assertRelationSideCanContinue(
  identifier: string,
  direction: "outbound" | "inbound",
  pageInfo: ListedRelationsPage["pageInfo"]["outbound"],
  seenCursors: Set<string>,
  added: number,
): void {
  if (!pageInfo.hasNextPage) return;
  if (!pageInfo.endCursor) {
    throw new ValidationError(
      `issue relation fetch for ${identifier} cannot continue ${direction} page`,
      "Linear returned hasNextPage without endCursor",
    );
  }
  if (seenCursors.has(pageInfo.endCursor)) {
    throw new ValidationError(
      `issue relation fetch for ${identifier} ${direction} cursor did not advance`,
      `Linear returned a repeated ${direction} endCursor while more pages were advertised`,
    );
  }
  if (added === 0) {
    throw new ValidationError(
      `issue relation fetch for ${identifier} ${direction} page made no progress`,
      `Linear returned hasNextPage for ${direction} relations but no records`,
    );
  }
  seenCursors.add(pageInfo.endCursor);
}

async function materializeInitiativeProjectsPage(
  initiativeId: string,
  limit: number,
  initialAfter?: string,
): Promise<InitiativeProjectsPage | null> {
  const first = await getInitiativeProjectsPage(initiativeId, {
    limit,
    ...(initialAfter ? { after: initialAfter } : {}),
  });
  if (!first) return null;
  const projects = [...first.projects.nodes];
  let pageInfo = first.projects.pageInfo;
  let after = pageInfo.endCursor ?? undefined;
  const seenCursors = new Set<string>();
  if (initialAfter) seenCursors.add(initialAfter);
  if (pageInfo.hasNextPage) {
    if (!after) {
      throw new ValidationError(
        "paginated initiative project fetch cannot continue",
        "Linear returned hasNextPage without endCursor",
      );
    }
    if (seenCursors.has(after)) {
      throw new ValidationError(
        "paginated initiative project fetch cursor did not advance",
        "Linear returned a repeated endCursor while more pages were advertised",
      );
    }
    if (projects.length === 0) {
      throw new ValidationError(
        "paginated initiative project fetch made no progress",
        "Linear returned hasNextPage but no projects for the requested page",
      );
    }
    seenCursors.add(after);
  }

  while (projects.length < limit && pageInfo.hasNextPage) {
    if (!after) {
      throw new ValidationError(
        "paginated initiative project fetch cannot continue",
        "Linear returned hasNextPage without endCursor",
      );
    }
    const page = await getInitiativeProjectsPage(initiativeId, {
      limit: limit - projects.length,
      after,
    });
    if (!page) break;
    const added = page.projects.nodes.slice(0, limit - projects.length);
    projects.push(...added);
    if (page.projects.pageInfo.hasNextPage && !page.projects.pageInfo.endCursor) {
      throw new ValidationError(
        "paginated initiative project fetch cannot continue",
        "Linear returned hasNextPage without endCursor",
      );
    }
    if (
      page.projects.pageInfo.hasNextPage &&
      page.projects.pageInfo.endCursor &&
      seenCursors.has(page.projects.pageInfo.endCursor)
    ) {
      throw new ValidationError(
        "paginated initiative project fetch cursor did not advance",
        "Linear returned a repeated endCursor while more pages were advertised",
      );
    }
    if (page.projects.pageInfo.hasNextPage && added.length === 0) {
      throw new ValidationError(
        "paginated initiative project fetch made no progress",
        "Linear returned hasNextPage but no projects for the requested page",
      );
    }
    pageInfo = page.projects.pageInfo;
    after = pageInfo.endCursor ?? undefined;
    if (pageInfo.hasNextPage && after) seenCursors.add(after);
  }

  return {
    initiative: first.initiative,
    projects: { nodes: projects, pageInfo },
  };
}

async function materializeInitiativeIdentityPage(
  initiativeId: string,
): Promise<InitiativeProjectsPage | null> {
  const page = await getInitiativeProjectsPage(initiativeId, { limit: 1 });
  if (!page) return null;
  return {
    initiative: page.initiative,
    projects: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

interface FetchCollectionFragment {
  files: ContextFile[];
  counts: Record<string, number>;
  completeness: Record<string, FetchCompletenessEntry>;
  omitted: string[];
  continuations: FetchContinuation[];
}

async function addIssueDossiersConcurrent(input: {
  files: ContextFile[];
  counts: Record<string, number>;
  completeness: Record<string, FetchCompletenessEntry>;
  omitted: string[];
  issues: ListedIssue[];
  include: Set<string>;
  limit: number;
  continuations: FetchContinuation[];
}): Promise<void> {
  const fragments = await mapLimit(input.issues, ISSUE_DOSSIER_CONCURRENCY, async (issue) => {
    const fragment: FetchCollectionFragment = {
      files: [],
      counts: {},
      completeness: {},
      omitted: [],
      continuations: [],
    };
    await addIssueDossierFiles({
      files: fragment.files,
      counts: fragment.counts,
      completeness: fragment.completeness,
      omitted: fragment.omitted,
      identifier: issue.identifier,
      fallbackIssue: issue,
      include: input.include,
      limit: input.limit,
      prefix: `issues/${safeSegment(issue.identifier)}`,
      continuations: fragment.continuations,
    });
    return fragment;
  });

  for (const fragment of fragments) {
    mergeFetchCollection(
      input.files,
      input.counts,
      input.completeness,
      input.omitted,
      input.continuations,
      fragment,
    );
  }
}

async function addIssueDocumentFiles(input: {
  files: ContextFile[];
  counts: Record<string, number>;
  completeness: Record<string, FetchCompletenessEntry>;
  continuations?: FetchContinuation[];
  issueId: string;
  identifier: string;
  prefix: string;
  limit: number;
  includeDetails: boolean;
  countKey: string;
  detailKey: string;
  aggregate: boolean;
  after?: string;
}): Promise<NonNullable<Awaited<ReturnType<typeof getDocument>>>[]> {
  const documentsPage = await materializePages(
    input.limit,
    (after, limit) => listDocumentsPage({ issueId: input.issueId, limit, after }),
    input.after,
  );
  const documents = documentsPage.nodes;
  input.counts[input.countKey] = (input.counts[input.countKey] ?? 0) + documents.length;
  if (input.aggregate) {
    markPageCompletenessAggregate(
      input.completeness,
      input.countKey,
      documents.length,
      input.limit,
      "per_parent",
      documentsPage.pageInfo,
    );
  } else {
    markPageCompleteness(
      input.completeness,
      input.countKey,
      documents.length,
      input.limit,
      documentsPage.pageInfo,
    );
  }
  input.files.push({
    relative: `${input.prefix}/documents.json`,
    content: `${JSON.stringify(documents, null, 2)}\n`,
  });
  pushPageContinuation(input.continuations, {
    key: input.countKey,
    path: `/issues/${input.identifier}/documents`,
    limit: input.limit,
    pageInfo: documentsPage.pageInfo,
    reason: "cursor",
    include: issueDocumentsContinuationInclude(input.includeDetails),
  });

  if (!input.includeDetails) return [];

  const materializedDocumentDetails = (
    await mapLimit(documents, ISSUE_DOSSIER_CONCURRENCY, async (document) =>
      getDocument(document.id),
    )
  ).filter((document): document is NonNullable<Awaited<ReturnType<typeof getDocument>>> =>
    Boolean(document),
  );
  input.counts[input.detailKey] =
    (input.counts[input.detailKey] ?? 0) + materializedDocumentDetails.length;
  markDocumentDetailsCompleteness(
    input.completeness,
    input.detailKey,
    materializedDocumentDetails.length,
    documents.length,
    input.aggregate,
  );
  for (const document of materializedDocumentDetails) {
    input.files.push({
      relative: `${input.prefix}/documents/${safeSegment(document.id)}/document.md`,
      content: renderEntityMarkdown("Document", document.title, document),
    });
  }
  return materializedDocumentDetails;
}

function mergeFetchCollection(
  files: ContextFile[],
  counts: Record<string, number>,
  completeness: Record<string, FetchCompletenessEntry>,
  omitted: string[],
  continuations: FetchContinuation[],
  fragment: FetchCollectionFragment,
): void {
  files.push(...fragment.files);
  for (const [key, value] of Object.entries(fragment.counts)) {
    counts[key] = (counts[key] ?? 0) + value;
  }
  for (const [key, entry] of Object.entries(fragment.completeness)) {
    mergeCompletenessEntry(completeness, key, entry);
  }
  for (const entry of fragment.omitted) {
    if (!omitted.includes(entry)) omitted.push(entry);
  }
  continuations.push(...fragment.continuations);
}

function mergeCompletenessEntry(
  completeness: Record<string, FetchCompletenessEntry>,
  key: string,
  entry: FetchCompletenessEntry,
): void {
  const existing = completeness[key];
  if (!existing) {
    completeness[key] = { ...entry };
    return;
  }
  completeness[key] = {
    returned: existing.returned + entry.returned,
    limit: existing.limit ?? entry.limit,
    complete: existing.complete && entry.complete,
    truncated: existing.truncated || entry.truncated,
    limit_semantics: existing.limit_semantics ?? entry.limit_semantics,
    ...(existing.total_available !== undefined || entry.total_available !== undefined
      ? { total_available: (existing.total_available ?? 0) + (entry.total_available ?? 0) }
      : {}),
    ...((existing.reason ?? entry.reason) ? { reason: existing.reason ?? entry.reason } : {}),
  };
}

async function addIssueDossierFiles(input: {
  files: ContextFile[];
  counts: Record<string, number>;
  completeness: Record<string, FetchCompletenessEntry>;
  omitted: string[];
  identifier: string;
  fallbackIssue: unknown;
  include: Set<string>;
  limit: number;
  prefix: string;
  continuations?: FetchContinuation[];
}): Promise<void> {
  const needsIssueRead =
    input.include.has("issue_details") ||
    input.include.has("agent_sessions") ||
    input.include.has("issue_documents") ||
    input.include.has("issue_document_details");
  const issueDetails = needsIssueRead ? await getIssue(input.identifier) : null;
  if (input.include.has("issue_details")) {
    input.counts.issue_details = (input.counts.issue_details ?? 0) + (issueDetails ? 1 : 0);
    markIssueDetailsCompletenessAggregate(input.completeness, Boolean(issueDetails));
  }
  const issue = issueDetails ?? input.fallbackIssue;
  const shallowFallback = input.include.has("issue_details") && !issueDetails;
  input.files.push({
    relative: `${input.prefix}/issue.md`,
    content: shallowFallback
      ? `${renderEntityMarkdown("Issue", input.identifier, issue)}\n\nNote: issue_details was requested, but full issue details were not available. This file contains shallow list data.\n`
      : renderEntityMarkdown("Issue", input.identifier, issue),
  });

  if (input.include.has("comments")) {
    const page = await materializeCommentPages(input.identifier, input.limit);
    input.counts.issue_comments = (input.counts.issue_comments ?? 0) + page.comments.length;
    markPageCompletenessAggregate(
      input.completeness,
      "issue_comments",
      page.comments.length,
      input.limit,
      "per_parent",
      page.pageInfo,
    );
    input.files.push({
      relative: `${input.prefix}/comments.md`,
      content: renderListMarkdown("Comments", page.comments),
    });
    pushPageContinuation(input.continuations, {
      key: "issue_comments",
      path: `/issues/${input.identifier}/comments`,
      limit: input.limit,
      pageInfo: page.pageInfo,
      reason: "cursor",
      include: continuationIncludeFor("issue_comments", input.include),
    });
  }

  if (input.include.has("relations")) {
    const relations = await materializeRelationPages(input.identifier, input.limit);
    input.counts.issue_relations =
      (input.counts.issue_relations ?? 0) + relations.outbound.length + relations.inbound.length;
    markRelationCompletenessAggregate(
      input.completeness,
      "issue_relations",
      relations.outbound.length + relations.inbound.length,
      input.limit,
      "per_parent_direction",
      relations,
    );
    input.files.push({
      relative: `${input.prefix}/relations.json`,
      content: `${JSON.stringify(relations, null, 2)}\n`,
    });
    pushRelationContinuation(
      input.continuations,
      "issue_relations",
      `/issues/${input.identifier}/relations`,
      input.limit,
      relations,
      continuationIncludeFor("issue_relations", input.include),
    );
  }

  if (input.include.has("attachments")) {
    const page = await materializeAttachmentPages(input.identifier, input.limit);
    input.counts.issue_attachments =
      (input.counts.issue_attachments ?? 0) + page.attachments.length;
    markPageCompletenessAggregate(
      input.completeness,
      "issue_attachments",
      page.attachments.length,
      input.limit,
      "per_parent",
      page.pageInfo,
    );
    input.files.push({
      relative: `${input.prefix}/attachments.json`,
      content: `${JSON.stringify(page.attachments, null, 2)}\n`,
    });
    pushPageContinuation(input.continuations, {
      key: "issue_attachments",
      path: `/issues/${input.identifier}/attachments`,
      limit: input.limit,
      pageInfo: page.pageInfo,
      reason: "cursor",
      include: continuationIncludeFor("issue_attachments", input.include),
    });
  }

  if (input.include.has("issue_documents")) {
    const issueId = (issue as { id?: string }).id;
    if (!issueId) {
      throw new ValidationError(
        `issue ${input.identifier} documents require the issue UUID`,
        "include issue_details or fetch the concrete issue so lebop can resolve the issue UUID",
      );
    }
    await addIssueDocumentFiles({
      files: input.files,
      counts: input.counts,
      completeness: input.completeness,
      continuations: input.continuations,
      issueId,
      identifier: input.identifier,
      prefix: input.prefix,
      limit: input.limit,
      includeDetails: input.include.has("issue_document_details"),
      countKey: "issue_documents",
      detailKey: "issue_document_details",
      aggregate: true,
    });
  }

  if (input.include.has("agent_sessions")) {
    const issueId = (issue as { id?: string }).id;
    if (!issueId) {
      throw new ValidationError(
        `issue ${input.identifier} agent sessions require the issue UUID`,
        "include issue_details or fetch the concrete issue so lebop can resolve the issue UUID",
      );
    }
    const sessionsPage = await listAgentSessionsPage({ issueId, limit: input.limit });
    const sessions = sessionsPage.nodes;
    input.counts.issue_agent_sessions = (input.counts.issue_agent_sessions ?? 0) + sessions.length;
    markPageCompletenessAggregate(
      input.completeness,
      "issue_agent_sessions",
      sessions.length,
      input.limit,
      "per_parent",
      sessionsPage.pageInfo,
    );
    input.files.push({
      relative: `${input.prefix}/agent-sessions.json`,
      content: `${JSON.stringify(sessions, null, 2)}\n`,
    });
    pushPageContinuation(input.continuations, {
      key: "issue_agent_sessions",
      path: `/issues/${input.identifier}/agent-sessions`,
      limit: input.limit,
      pageInfo: sessionsPage.pageInfo,
      reason: "cursor",
      include: continuationIncludeFor("issue_agent_sessions", input.include),
    });
  }
}

function includeSet(
  include: string[] | undefined,
  defaults: Set<string>,
  allowed: Set<string>,
  context: string,
): Set<string> {
  if (include === undefined) return new Set(defaults);
  const parsed = new Set(
    include
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim())
      .map((entry) => entry.replace(/-/g, "_"))
      .filter(Boolean),
  );
  const unknown = [...parsed].filter((entry) => !allowed.has(entry));
  if (unknown.length > 0) {
    throw new ValidationError(
      `unknown ${context} include: ${unknown.join(", ")}`,
      `allowed includes: ${[...allowed].sort().join(", ")}`,
    );
  }
  return parsed;
}

const ISSUE_DERIVED_INCLUDES = new Set([
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "agent_sessions",
  "issue_documents",
  "issue_document_details",
]);

function continuationIncludeFor(key: string, include: Set<string>): string[] | undefined {
  switch (key) {
    case "issues":
      return issueCollectionContinuationInclude(include);
    case "project_issues":
      return projectIssueCollectionContinuationInclude(include);
    case "projects":
      return initiativeProjectContinuationInclude(include);
    case "documents":
      return sortedIncludeArgs(
        "documents",
        include.has("document_details") ? "document_details" : undefined,
      );
    case "project_documents":
      return sortedIncludeArgs(
        "documents",
        include.has("project_document_details") ? "document_details" : undefined,
      );
    case "issue_documents":
      return issueDocumentsContinuationInclude(include.has("issue_document_details"));
    case "comments":
    case "issue_comments":
      return sortedIncludeArgs("comments");
    case "relations":
    case "issue_relations":
      return sortedIncludeArgs("relations");
    case "attachments":
    case "issue_attachments":
      return sortedIncludeArgs("attachments");
    case "agent_sessions":
    case "issue_agent_sessions":
      return sortedIncludeArgs("agent_sessions");
    case "updates":
    case "project_updates":
    case "initiative_updates":
      return sortedIncludeArgs("updates");
    case "milestones":
    case "project_milestones":
      return sortedIncludeArgs("milestones");
    default:
      return undefined;
  }
}

function issueCollectionContinuationInclude(include: Set<string>): string[] {
  return (
    sortedIncludeArgs(
      "issues",
      ...[...ISSUE_DERIVED_INCLUDES].filter((entry) => include.has(entry)),
    ) ?? ["issues"]
  );
}

function projectIssueCollectionContinuationInclude(include: Set<string>): string[] {
  return (
    sortedIncludeArgs(
      "issues",
      ...[...ISSUE_DERIVED_INCLUDES].filter((entry) => include.has(entry)),
    ) ?? ["issues"]
  );
}

function initiativeProjectContinuationInclude(include: Set<string>): string[] {
  return (
    sortedIncludeArgs(
      "projects",
      include.has("project_issues") ? "project_issues" : undefined,
      include.has("project_documents") ? "project_documents" : undefined,
      include.has("project_document_details") ? "project_document_details" : undefined,
      include.has("project_updates") ? "project_updates" : undefined,
      include.has("project_milestones") ? "project_milestones" : undefined,
      ...[...ISSUE_DERIVED_INCLUDES].filter((entry) => include.has(entry)),
    ) ?? ["projects"]
  );
}

function issueDocumentsContinuationInclude(includeDetails: boolean): string[] {
  return (
    sortedIncludeArgs("documents", includeDetails ? "document_details" : undefined) ?? ["documents"]
  );
}

function sortedIncludeArgs(...values: Array<string | undefined>): string[] | undefined {
  const includes = [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
  return includes.length > 0 ? includes : undefined;
}

function normalizeProjectIncludes(include: Set<string>): void {
  if (include.has("document_details")) include.add("documents");
  if (include.has("issue_document_details")) include.add("issue_documents");
  for (const dependency of ISSUE_DERIVED_INCLUDES) {
    if (include.has(dependency)) {
      include.add("issues");
      return;
    }
  }
}

function normalizeInitiativeIncludes(include: Set<string>): void {
  if (include.has("project_issues")) include.add("projects");
  if (include.has("project_document_details")) include.add("project_documents");
  if (
    include.has("project_documents") ||
    include.has("project_updates") ||
    include.has("project_milestones")
  ) {
    include.add("projects");
  }
  if (include.has("issue_document_details")) include.add("issue_documents");
  for (const dependency of ISSUE_DERIVED_INCLUDES) {
    if (include.has(dependency)) {
      include.add("projects");
      include.add("project_issues");
      return;
    }
  }
}

function normalizeIssueCollectionIncludes(include: Set<string>): void {
  if (include.has("issue_document_details")) include.add("issue_documents");
  for (const dependency of ISSUE_DERIVED_INCLUDES) {
    if (include.has(dependency)) {
      include.add("issues");
      return;
    }
  }
}

function normalizeDirectIssueIncludes(include: Set<string>): void {
  if (include.has("document_details")) include.add("documents");
}

function projectDefaults(parsed: ParsedWorkspacePath): Set<string> {
  if (parsed.kind !== "project_child") return DEFAULT_PROJECT_INCLUDES;
  if (parsed.child === "issues")
    return new Set([
      "issues",
      "issue_details",
      "comments",
      "relations",
      "attachments",
      "issue_documents",
      "issue_document_details",
    ]);
  if (parsed.child === "documents") return new Set(["documents", "document_details"]);
  return new Set([parsed.child ?? "issues"]);
}

function issueDefaults(parsed: ParsedWorkspacePath): Set<string> {
  if (parsed.kind !== "issue_child") return DEFAULT_ISSUE_INCLUDES;
  if (parsed.child === "agent-sessions") return new Set(["agent_sessions"]);
  if (parsed.child === "documents") return new Set(["documents", "document_details"]);
  return new Set([parsed.child ?? "comments"]);
}

function initiativeDefaults(parsed: ParsedWorkspacePath): Set<string> {
  if (parsed.kind !== "initiative_child") return DEFAULT_INITIATIVE_INCLUDES;
  if (parsed.child === "projects")
    return new Set([
      "projects",
      "project_issues",
      "project_documents",
      "project_document_details",
      "project_updates",
      "project_milestones",
      "issue_details",
      "comments",
      "relations",
      "attachments",
      "issue_documents",
      "issue_document_details",
    ]);
  return new Set([parsed.child ?? "projects"]);
}

function selectionFor(parsed: ParsedWorkspacePath, include: Set<string>): FetchSelection {
  return {
    requested_path_kind: parsed.kind,
    focused_collection: parsed.child ?? null,
    selected_includes: [...include].sort(),
  };
}

function recommendedReads(paths: Array<string | null | undefined>): string[] {
  return [
    ...new Set([
      ...paths.filter((p): p is string => Boolean(p)),
      "index.md",
      "summary.json",
      "manifest.json",
    ]),
  ];
}

function recommendedList(paths: string[]): string[] {
  return paths.filter((path) => path !== "index.md").map((path) => `- ${path}`);
}

function markComplete(
  completeness: Record<string, FetchCompletenessEntry>,
  key: string,
  returned: number,
): void {
  completeness[key] = {
    returned,
    limit: null,
    complete: true,
    truncated: false,
  };
}

function markPageCompleteness(
  completeness: Record<string, FetchCompletenessEntry>,
  key: string,
  returned: number,
  limit: number,
  pageInfo: { hasNextPage: boolean },
): void {
  const complete = !pageInfo.hasNextPage;
  completeness[key] = {
    returned,
    limit,
    complete,
    truncated: !complete,
    limit_semantics: "per_collection",
    ...(complete ? {} : { reason: "cursor" }),
  };
}

function markRelationCompleteness(
  completeness: Record<string, FetchCompletenessEntry>,
  key: string,
  returned: number,
  limit: number,
  relations: { complete?: boolean },
): void {
  const complete = relations.complete !== false;
  completeness[key] = {
    returned,
    limit,
    complete,
    truncated: !complete,
    limit_semantics: "per_direction",
    ...(complete ? {} : { reason: "relation_page_may_have_more" }),
  };
}

function markRelationCompletenessAggregate(
  completeness: Record<string, FetchCompletenessEntry>,
  key: string,
  returned: number,
  limit: number,
  limitSemantics: FetchCompletenessEntry["limit_semantics"],
  relations: { complete?: boolean },
): void {
  const existing = completeness[key];
  const complete = relations.complete !== false;
  completeness[key] = {
    returned: (existing?.returned ?? 0) + returned,
    limit,
    complete: (existing?.complete ?? true) && complete,
    truncated: (existing?.truncated ?? false) || !complete,
    limit_semantics: limitSemantics,
    ...(existing?.total_available === undefined
      ? {}
      : { total_available: existing.total_available }),
    ...((existing?.truncated ?? false) || !complete
      ? { reason: existing?.reason ?? "relation_page_may_have_more" }
      : {}),
  };
}

function markPageCompletenessAggregate(
  completeness: Record<string, FetchCompletenessEntry>,
  key: string,
  returned: number,
  limit: number,
  limitSemantics: FetchCompletenessEntry["limit_semantics"],
  pageInfo: { hasNextPage: boolean },
): void {
  const existing = completeness[key];
  const complete = !pageInfo.hasNextPage;
  completeness[key] = {
    returned: (existing?.returned ?? 0) + returned,
    limit,
    complete: (existing?.complete ?? true) && complete,
    truncated: (existing?.truncated ?? false) || !complete,
    limit_semantics: limitSemantics,
    ...((existing?.truncated ?? false) || !complete ? { reason: "cursor" } : {}),
  };
}

function markIssueDetailsCompletenessAggregate(
  completeness: Record<string, FetchCompletenessEntry>,
  found: boolean,
): void {
  const existing = completeness.issue_details;
  completeness.issue_details = {
    returned: (existing?.returned ?? 0) + (found ? 1 : 0),
    limit: null,
    complete: (existing?.complete ?? true) && found,
    truncated: (existing?.truncated ?? false) || !found,
    total_available: (existing?.total_available ?? 0) + 1,
    limit_semantics: "per_parent",
    ...((existing?.truncated ?? false) || !found
      ? { reason: existing?.reason ?? "not_available: issue_detail_missing" }
      : {}),
  };
}

function markDocumentDetailsCompleteness(
  completeness: Record<string, FetchCompletenessEntry>,
  key: string,
  returned: number,
  total: number,
  aggregate: boolean,
): void {
  const complete = returned === total;
  if (!aggregate) {
    completeness[key] = {
      returned,
      limit: total,
      complete,
      truncated: !complete,
      limit_semantics: "per_collection",
      ...(complete ? {} : { reason: "not_available: document_missing" }),
    };
    return;
  }

  const existing = completeness[key];
  completeness[key] = {
    returned: (existing?.returned ?? 0) + returned,
    limit: null,
    complete: (existing?.complete ?? true) && complete,
    truncated: (existing?.truncated ?? false) || !complete,
    total_available: (existing?.total_available ?? 0) + total,
    limit_semantics: "per_parent",
    ...((existing?.truncated ?? false) || !complete
      ? { reason: existing?.reason ?? "not_available: document_missing" }
      : {}),
  };
}

function isTruncated(completeness: Record<string, FetchCompletenessEntry>): boolean {
  return Object.values(completeness).some((entry) => entry.truncated);
}

function continuationHints(input: {
  target: string;
  kind: string;
  depth?: FetchDepth;
  limit: number;
  completeness: Record<string, FetchCompletenessEntry>;
  childTargets: Partial<Record<string, string>>;
}): FetchContinuation[] {
  const continuations: FetchContinuation[] = [];
  for (const [key, entry] of Object.entries(input.completeness)) {
    if (!entry.truncated) continue;
    const target = input.childTargets[key];
    if (!target) continue;
    continuations.push({
      tool: "explore_linear_workspace",
      reason: `${key} was truncated (${entry.reason ?? "limit"}); inspect the exact child collection and use next_cursor if present`,
      args: {
        path: target,
        limit: input.limit,
      },
    });
  }
  return continuations;
}

function exploreContinuation(
  key: string,
  path: string,
  limit: number,
  reason: string,
  cursor?: string | null,
): FetchContinuation {
  return {
    tool: "explore_linear_workspace",
    reason: cursor
      ? `${key} was truncated (${reason}); continue the exact child collection from the supplied cursor`
      : `${key} was truncated (${reason}); inspect the exact child collection and use next_cursor if present`,
    args: { path, limit, ...(cursor ? { cursor } : {}) },
  };
}

function fetchContinuation(
  key: string,
  target: string,
  limit: number,
  reason: string,
  cursor: string | null,
  depth?: FetchDepth,
  include?: string[],
): FetchContinuation {
  if (!cursor) return exploreContinuation(key, target, limit, "not_available", cursor);
  return {
    tool: "fetch_linear_workspace",
    reason: `${key} was truncated (${reason}); fetch the next materialized page from the supplied cursor`,
    args: {
      target,
      limit,
      cursor,
      ...(depth ? { depth } : {}),
      ...(include ? { include } : {}),
    },
  };
}

function pushPageContinuation(
  continuations: FetchContinuation[] | undefined,
  input: {
    key: string;
    path: string;
    limit: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    reason: string;
    depth?: FetchDepth;
    include?: string[];
  },
): void {
  if (!continuations || !input.pageInfo.hasNextPage) return;
  const cursor = input.pageInfo.endCursor
    ? childExploreCursor(input.path, { main: input.pageInfo.endCursor })
    : null;
  continuations.push(
    fetchContinuation(
      input.key,
      input.path,
      input.limit,
      input.reason,
      cursor,
      input.depth,
      input.include,
    ),
  );
}

function pushRelationContinuation(
  continuations: FetchContinuation[] | undefined,
  key: string,
  path: string,
  limit: number,
  relations: ListedRelationsPage,
  include?: string[],
): void {
  if (!continuations || relations.complete !== false) return;
  const cursors = relationNextCursors(relations);
  const cursor = Object.keys(cursors).length > 0 ? childExploreCursor(path, cursors) : null;
  continuations.push(
    fetchContinuation(
      key,
      path,
      limit,
      cursor ? "cursor" : "not_available",
      cursor,
      undefined,
      include,
    ),
  );
}

function childExploreCursor(path: string, cursors: Record<string, string>): string | null {
  const payload: ExploreCursor = {
    v: 1,
    path,
    query: null,
    team: null,
    allTeams: false,
    kinds: null,
    includeArchived: false,
    cursors,
  };
  return encodeExploreCursor(payload);
}

function relationNextCursors(relations: ListedRelationsPage): Record<string, string> {
  const cursors: Record<string, string> = {};
  if (relations.pageInfo.outbound.hasNextPage && relations.pageInfo.outbound.endCursor) {
    cursors.outbound = relations.pageInfo.outbound.endCursor;
  }
  if (relations.pageInfo.inbound.hasNextPage && relations.pageInfo.inbound.endCursor) {
    cursors.inbound = relations.pageInfo.inbound.endCursor;
  }
  return cursors;
}

function dedupeContinuations(continuations: FetchContinuation[]): FetchContinuation[] {
  const seen = new Set<string>();
  return continuations.filter((continuation) => {
    const signature = JSON.stringify([continuation.tool, continuation.args]);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function omitDocumentContent<T extends { content?: string | null }>(
  document: T,
): Omit<T, "content"> {
  const { content: _content, ...rest } = document;
  return rest;
}

function renderEntityMarkdown(kind: string, title: string, value: unknown): string {
  return `# ${kind}: ${title}${markdownJsonBlock(value)}`;
}

function renderListMarkdown(title: string, values: unknown[]): string {
  if (values.length === 0) return `# ${title}\n\nNo records.\n`;
  return `# ${title}${markdownJsonBlock(values)}`;
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const normalized = Math.floor(limit);
  if (normalized < 1 || normalized > 1000) {
    throw new ValidationError(
      `fetch limit must be between 1 and 1000, got ${limit}`,
      "pass a limit in the same range accepted by the MCP fetch_linear_workspace schema",
    );
  }
  return normalized;
}

function normalizeDepth(depth?: FetchDepth): FetchDepth {
  if (depth === undefined) return DEFAULT_DEPTH;
  if (depth === "shallow" || depth === "full") return depth;
  throw new ValidationError(
    `fetch depth must be shallow or full, got ${String(depth)}`,
    "pass --depth shallow or --depth full",
  );
}

function currentRepoHash(repoRootOverride?: string): string {
  const cwd = repoRootOverride ? resolvePath(repoRootOverride) : process.cwd();
  const repoRoot = findGitRoot(cwd);
  if (repoRootOverride && !repoRoot) {
    throw new ValidationError(
      `repo_root is not inside a git repository: ${cwd}`,
      "pass a path inside the intended repo, or omit repo_root to use the MCP server cwd/global context behavior",
    );
  }
  return repoRoot ? hashRepoRoot(repoRoot) : "_global";
}
