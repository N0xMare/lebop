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

export async function fetchAgentSessionContext(input: {
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
