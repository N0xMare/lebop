/**
 * Mechanical extract from workspaceFetch — kind context.
 */

import { getAgentSession, listAgentSessionsPage } from "../agentSessions.ts";
import { listAttachmentsPage } from "../attachments.ts";
import { listCommentsPage } from "../comments.ts";
import { mapLimit } from "../concurrency.ts";
import { getCycle } from "../cycles.ts";
import { type getDocument, listDocumentsPage } from "../documents.ts";
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

export async function fetchIssueContext(input: {
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
