/**
 * Shared constants and helpers for workspace fetch (mechanical extract).
 */
import { dirname, resolve as resolvePath } from "node:path";
import { listAgentSessionsPage } from "../agentSessions.ts";
import { listAttachmentsPage } from "../attachments.ts";
import { listCommentsPage } from "../comments.ts";
import { mapLimit } from "../concurrency.ts";
import { findGitRoot, hashRepoRoot } from "../config.ts";
import { getDocument, listDocumentsPage } from "../documents.ts";
import { ValidationError } from "../errors.ts";
import {
  getInitiativeProjectsPage,
  type InitiativeProjectsPage,
  listInitiativeUpdatesPage,
} from "../initiatives.ts";
import { getIssue } from "../issues.ts";
import { type ListedIssue, listIssuesPage } from "../listIssues.ts";
import { listMilestonesPage } from "../milestones.ts";
import type { ConnectionPage } from "../paginate.ts";
import { listProjectUpdatesPage } from "../projects.ts";
import { type ListedRelationsPage, listRelationsPage } from "../relations.ts";
import {
  type ContextFile,
  markdownJsonBlock,
} from "../workspaceContextWriter.ts";
import {
  decodeExploreCursor,
  type ExploreCursor,
  encodeExploreCursor,
} from "../workspaceExplore.ts";
import type { ParsedWorkspacePath } from "../workspacePaths.ts";
import { parseWorkspacePath, safeSegment } from "../workspacePaths.ts";
import type {
  FetchCompletenessEntry,
  FetchContinuation,
  FetchDepth,
  FetchLinearWorkspaceResult,
  FetchSelection,
  FetchCollectionFragment,
} from "./fetchTypes.ts";

export const DEFAULT_LIMIT = 100;
export const DEFAULT_DEPTH: FetchDepth = "full";
export const DEFAULT_PROJECT_INCLUDES = new Set([
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
export const DEFAULT_ISSUE_INCLUDES = new Set([
  "comments",
  "relations",
  "attachments",
  "documents",
  "document_details",
]);
export const DEFAULT_INITIATIVE_INCLUDES = new Set([
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
export const DEFAULT_DOCUMENT_INCLUDES = new Set(["content"]);
export const DEFAULT_CYCLE_INCLUDES = new Set([
  "issues",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "issue_documents",
  "issue_document_details",
]);
export const DEFAULT_MILESTONE_INCLUDES = new Set([
  "issues",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "issue_documents",
  "issue_document_details",
]);
export const ISSUE_DOSSIER_CONCURRENCY = 6;

export const ALLOWED_PROJECT_INCLUDES = new Set([
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
export const ALLOWED_ISSUE_INCLUDES = new Set([
  "comments",
  "relations",
  "attachments",
  "agent_sessions",
  "documents",
  "document_details",
]);
export const ALLOWED_INITIATIVE_INCLUDES = new Set([
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
export const ALLOWED_DOCUMENT_INCLUDES = new Set(["content"]);
export const ALLOWED_CYCLE_INCLUDES = new Set([
  "issues",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "agent_sessions",
  "issue_documents",
  "issue_document_details",
]);
export const ALLOWED_MILESTONE_INCLUDES = new Set([
  "issues",
  "issue_details",
  "comments",
  "relations",
  "attachments",
  "agent_sessions",
  "issue_documents",
  "issue_document_details",
]);


export function addWorkspaceToContinuations(
  result: FetchLinearWorkspaceResult,
  workspace: string | undefined,
): FetchLinearWorkspaceResult {
  if (!workspace || result.continuations.length === 0) return result;
  return {
    ...result,
    continuations: addWorkspaceToContinuationList(result.continuations, workspace),
  };
}

export function addWorkspaceToContinuationList(
  continuations: FetchContinuation[],
  workspace: string | undefined,
): FetchContinuation[] {
  if (!workspace || continuations.length === 0) return continuations;
  return continuations.map((continuation) => ({
    ...continuation,
    args: { ...continuation.args, workspace },
  }));
}

export function decodeFetchCursor(
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

export function validateExplicitOutputRoot(to: string | undefined): void {
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

export function focusedCursorAfter(
  selection: FetchSelection,
  cursor: ExploreCursor | null,
  collection: string,
): string | undefined {
  if (selection.focused_collection !== collection) return undefined;
  return cursor?.cursors.main;
}

export function focusedRelationCursors(
  selection: FetchSelection,
  cursor: ExploreCursor | null,
): Record<string, string> | undefined {
  if (selection.focused_collection !== "relations") return undefined;
  return cursor?.cursors;
}


export async function materializePages<T>(
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

export async function materializeCommentPages(
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

export async function materializeAttachmentPages(
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

export async function materializeRelationPages(
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

export function assertRelationSideCanContinue(
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

export async function materializeInitiativeProjectsPage(
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

export async function materializeInitiativeIdentityPage(
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

export async function addIssueDossiersConcurrent(input: {
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

export async function addIssueDocumentFiles(input: {
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

export function mergeFetchCollection(
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

export function mergeCompletenessEntry(
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

export async function addIssueDossierFiles(input: {
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

export function includeSet(
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

export function continuationIncludeFor(key: string, include: Set<string>): string[] | undefined {
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

export function issueCollectionContinuationInclude(include: Set<string>): string[] {
  return (
    sortedIncludeArgs(
      "issues",
      ...[...ISSUE_DERIVED_INCLUDES].filter((entry) => include.has(entry)),
    ) ?? ["issues"]
  );
}

export function projectIssueCollectionContinuationInclude(include: Set<string>): string[] {
  return (
    sortedIncludeArgs(
      "issues",
      ...[...ISSUE_DERIVED_INCLUDES].filter((entry) => include.has(entry)),
    ) ?? ["issues"]
  );
}

export function initiativeProjectContinuationInclude(include: Set<string>): string[] {
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

export function issueDocumentsContinuationInclude(includeDetails: boolean): string[] {
  return (
    sortedIncludeArgs("documents", includeDetails ? "document_details" : undefined) ?? ["documents"]
  );
}

export function sortedIncludeArgs(...values: Array<string | undefined>): string[] | undefined {
  const includes = [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
  return includes.length > 0 ? includes : undefined;
}

export function normalizeProjectIncludes(include: Set<string>): void {
  if (include.has("document_details")) include.add("documents");
  if (include.has("issue_document_details")) include.add("issue_documents");
  for (const dependency of ISSUE_DERIVED_INCLUDES) {
    if (include.has(dependency)) {
      include.add("issues");
      return;
    }
  }
}

export function normalizeInitiativeIncludes(include: Set<string>): void {
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

export function normalizeIssueCollectionIncludes(include: Set<string>): void {
  if (include.has("issue_document_details")) include.add("issue_documents");
  for (const dependency of ISSUE_DERIVED_INCLUDES) {
    if (include.has(dependency)) {
      include.add("issues");
      return;
    }
  }
}

export function normalizeDirectIssueIncludes(include: Set<string>): void {
  if (include.has("document_details")) include.add("documents");
}

export function projectDefaults(parsed: ParsedWorkspacePath): Set<string> {
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

export function issueDefaults(parsed: ParsedWorkspacePath): Set<string> {
  if (parsed.kind !== "issue_child") return DEFAULT_ISSUE_INCLUDES;
  if (parsed.child === "agent-sessions") return new Set(["agent_sessions"]);
  if (parsed.child === "documents") return new Set(["documents", "document_details"]);
  return new Set([parsed.child ?? "comments"]);
}

export function initiativeDefaults(parsed: ParsedWorkspacePath): Set<string> {
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

export function selectionFor(parsed: ParsedWorkspacePath, include: Set<string>): FetchSelection {
  return {
    requested_path_kind: parsed.kind,
    focused_collection: parsed.child ?? null,
    selected_includes: [...include].sort(),
  };
}

export function recommendedReads(paths: Array<string | null | undefined>): string[] {
  return [
    ...new Set([
      ...paths.filter((p): p is string => Boolean(p)),
      "index.md",
      "summary.json",
      "manifest.json",
    ]),
  ];
}

export function recommendedList(paths: string[]): string[] {
  return paths.filter((path) => path !== "index.md").map((path) => `- ${path}`);
}

export function markComplete(
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

export function markPageCompleteness(
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

export function markRelationCompleteness(
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

export function markRelationCompletenessAggregate(
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

export function markPageCompletenessAggregate(
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

export function markIssueDetailsCompletenessAggregate(
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

export function markDocumentDetailsCompleteness(
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

export function isTruncated(completeness: Record<string, FetchCompletenessEntry>): boolean {
  return Object.values(completeness).some((entry) => entry.truncated);
}

export function continuationHints(input: {
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

export function exploreContinuation(
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

export function fetchContinuation(
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

export function pushPageContinuation(
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

export function pushRelationContinuation(
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

export function childExploreCursor(path: string, cursors: Record<string, string>): string | null {
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

export function relationNextCursors(relations: ListedRelationsPage): Record<string, string> {
  const cursors: Record<string, string> = {};
  if (relations.pageInfo.outbound.hasNextPage && relations.pageInfo.outbound.endCursor) {
    cursors.outbound = relations.pageInfo.outbound.endCursor;
  }
  if (relations.pageInfo.inbound.hasNextPage && relations.pageInfo.inbound.endCursor) {
    cursors.inbound = relations.pageInfo.inbound.endCursor;
  }
  return cursors;
}

export function dedupeContinuations(continuations: FetchContinuation[]): FetchContinuation[] {
  const seen = new Set<string>();
  return continuations.filter((continuation) => {
    const signature = JSON.stringify([continuation.tool, continuation.args]);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function omitDocumentContent<T extends { content?: string | null }>(
  document: T,
): Omit<T, "content"> {
  const { content: _content, ...rest } = document;
  return rest;
}

export function renderEntityMarkdown(kind: string, title: string, value: unknown): string {
  return `# ${kind}: ${title}${markdownJsonBlock(value)}`;
}

export function renderListMarkdown(title: string, values: unknown[]): string {
  if (values.length === 0) return `# ${title}\n\nNo records.\n`;
  return `# ${title}${markdownJsonBlock(values)}`;
}

export function normalizeLimit(limit?: number): number {
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

export function normalizeDepth(depth?: FetchDepth): FetchDepth {
  if (depth === undefined) return DEFAULT_DEPTH;
  if (depth === "shallow" || depth === "full") return depth;
  throw new ValidationError(
    `fetch depth must be shallow or full, got ${String(depth)}`,
    "pass --depth shallow or --depth full",
  );
}

export function currentRepoHash(repoRootOverride?: string): string {
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

