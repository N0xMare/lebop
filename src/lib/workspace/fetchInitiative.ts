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

export async function fetchInitiativeContext(input: {
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
