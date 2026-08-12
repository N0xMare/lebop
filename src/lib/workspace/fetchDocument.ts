/**
 * Mechanical extract from workspaceFetch — kind context.
 */
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
import { getAgentSession, listAgentSessionsPage } from "../agentSessions.ts";
import { listAttachmentsPage } from "../attachments.ts";
import { listCommentsPage } from "../comments.ts";
import {
  type ContextFile,
  markdownJsonBlock,
  writeWorkspaceContext,
} from "../workspaceContextWriter.ts";
import type { ExploreCursor } from "../workspaceExplore.ts";
import type { ParsedWorkspacePath } from "../workspacePaths.ts";
import { safeSegment } from "../workspacePaths.ts";
import type {
  FetchCompletenessEntry,
  FetchContinuation,
  FetchDepth,
  FetchLinearWorkspaceResult,
  FetchSelection,
} from "./fetchTypes.ts";
import {
  addIssueDossierFiles,
  addIssueDossiersConcurrent,
  addIssueDocumentFiles,
  continuationHints,
  continuationIncludeFor,
  dedupeContinuations,
  exploreContinuation,
  fetchContinuation,
  focusedCursorAfter,
  focusedRelationCursors,
  includeSet,
  initiativeProjectContinuationInclude,
  isTruncated,
  issueCollectionContinuationInclude,
  issueDocumentsContinuationInclude,
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
  DEFAULT_LIMIT,
  DEFAULT_DEPTH,
  DEFAULT_PROJECT_INCLUDES,
  DEFAULT_ISSUE_INCLUDES,
  DEFAULT_INITIATIVE_INCLUDES,
  DEFAULT_DOCUMENT_INCLUDES,
  DEFAULT_CYCLE_INCLUDES,
  DEFAULT_MILESTONE_INCLUDES,
  ALLOWED_PROJECT_INCLUDES,
  ALLOWED_ISSUE_INCLUDES,
  ALLOWED_INITIATIVE_INCLUDES,
  ALLOWED_DOCUMENT_INCLUDES,
  ALLOWED_CYCLE_INCLUDES,
  ALLOWED_MILESTONE_INCLUDES,
  ISSUE_DOSSIER_CONCURRENCY,
} from "./fetchShared.ts";

export async function fetchDocumentContext(input: {
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

