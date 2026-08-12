/**
 * Mechanical extract from workspaceFetch — kind context.
 */

import { getAgentSession, listAgentSessionsPage } from "../agentSessions.ts";
import { listAttachmentsPage } from "../attachments.ts";
import { listCommentsPage } from "../comments.ts";
import { mapLimit } from "../concurrency.ts";
import { getCycle } from "../cycles.ts";
import { getDocument, listDocumentsPage } from "../documents.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { getInitiativeProjectsPage, listInitiativeUpdatesPage } from "../initiatives.ts";
import { getIssue } from "../issues.ts";
import { type ListedIssue, listIssuesPage } from "../listIssues.ts";
import { getMilestone, listMilestonesPage } from "../milestones.ts";
import { getProject, listProjectUpdatesPage } from "../projects.ts";
import { listRelationsPage } from "../relations.ts";
import {
  type ContextFile,
  markdownJsonBlock,
  writeWorkspaceContext,
} from "../workspaceContextWriter.ts";
import type { ExploreCursor } from "../workspaceExplore.ts";
import type { ParsedWorkspacePath } from "../workspacePaths.ts";
import { safeSegment } from "../workspacePaths.ts";
import {
  ALLOWED_CYCLE_INCLUDES,
  ALLOWED_DOCUMENT_INCLUDES,
  ALLOWED_INITIATIVE_INCLUDES,
  ALLOWED_ISSUE_INCLUDES,
  ALLOWED_MILESTONE_INCLUDES,
  ALLOWED_PROJECT_INCLUDES,
  addIssueDocumentFiles,
  addIssueDossierFiles,
  addIssueDossiersConcurrent,
  addWorkspaceToContinuationList,
  continuationHints,
  continuationIncludeFor,
  DEFAULT_CYCLE_INCLUDES,
  DEFAULT_DEPTH,
  DEFAULT_DOCUMENT_INCLUDES,
  DEFAULT_INITIATIVE_INCLUDES,
  DEFAULT_ISSUE_INCLUDES,
  DEFAULT_LIMIT,
  DEFAULT_MILESTONE_INCLUDES,
  DEFAULT_PROJECT_INCLUDES,
  dedupeContinuations,
  exploreContinuation,
  fetchContinuation,
  focusedCursorAfter,
  focusedRelationCursors,
  ISSUE_DOSSIER_CONCURRENCY,
  includeSet,
  initiativeProjectContinuationInclude,
  issueCollectionContinuationInclude,
  issueDocumentsContinuationInclude,
  isTruncated,
  markComplete,
  markDocumentDetailsCompleteness,
  markIssueDetailsCompletenessAggregate,
  markPageCompleteness,
  markPageCompletenessAggregate,
  markRelationCompleteness,
  markRelationCompletenessAggregate,
  materializeAttachmentPages,
  materializeCommentPages,
  materializeInitiativeIdentityPage,
  materializeInitiativeProjectsPage,
  materializePages,
  materializeRelationPages,
  mergeCompletenessEntry,
  mergeFetchCollection,
  normalizeDirectIssueIncludes,
  normalizeInitiativeIncludes,
  normalizeIssueCollectionIncludes,
  normalizeProjectIncludes,
  omitDocumentContent,
  projectIssueCollectionContinuationInclude,
  pushPageContinuation,
  pushRelationContinuation,
  recommendedList,
  recommendedReads,
  relationNextCursors,
  renderEntityMarkdown,
  renderListMarkdown,
  selectionFor,
  sortedIncludeArgs,
} from "./fetchShared.ts";
import type {
  FetchCompletenessEntry,
  FetchContinuation,
  FetchDepth,
  FetchLinearWorkspaceResult,
  FetchSelection,
} from "./fetchTypes.ts";

export async function fetchProjectContext(input: {
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
