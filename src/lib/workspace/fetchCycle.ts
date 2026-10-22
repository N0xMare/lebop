/**
 * Mechanical extract from workspaceFetch — kind context.
 */

import { getCycle } from "../cycles.ts";
import { NotFoundError } from "../errors.ts";
import { type ListedIssue, listIssuesPage } from "../listIssues.ts";
import {
  type ContextFile,
  markdownJsonBlock,
  writeWorkspaceContext,
} from "../workspaceContextWriter.ts";
import type { ExploreCursor } from "../workspaceExplore.ts";
import { safeSegment } from "../workspacePaths.ts";
import {
  addIssueDossiersConcurrent,
  addWorkspaceToContinuationList,
  continuationHints,
  continuationIncludeFor,
  dedupeContinuations,
  focusedCursorAfter,
  isTruncated,
  markComplete,
  markPageCompleteness,
  materializePages,
  pushPageContinuation,
  recommendedList,
  recommendedReads,
  renderEntityMarkdown,
} from "./fetchShared.ts";
import type {
  FetchCompletenessEntry,
  FetchContinuation,
  FetchDepth,
  FetchLinearWorkspaceResult,
  FetchSelection,
} from "./fetchTypes.ts";

export async function fetchCycleContext(input: {
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
