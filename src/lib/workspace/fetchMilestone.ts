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

export async function fetchMilestoneContext(input: {
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
