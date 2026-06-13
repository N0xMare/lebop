import { mapLimit } from "./concurrency.ts";
import { rewriteNotFound, ValidationError } from "./errors.ts";
import { normalizeIssueIdentifierOrUuid } from "./issueIdentifiers.ts";
import { paginateRaw } from "./paginate.ts";
import { withRetry } from "./retry.ts";
export const ISSUE_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment IssueFields on Issue {
    id
    identifier
    title
    description
    priority
    estimate
    url
    updatedAt
    state {
      id
      name
      type
    }
    assignee {
      id
      name
      email
    }
    project {
      id
      name
    }
    projectMilestone {
      id
      name
    }
    cycle {
      id
      name
    }
    team {
      id
      key
    }
    parent {
      id
      identifier
    }
    labels {
      nodes {
        id
        name
      }
    }
  }
`;

export const COMMENTS_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment CommentFields on Issue {
    comments(first: 250) {
      nodes {
        id
        body
        createdAt
        updatedAt
        user {
          id
          name
          email
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const RELATIONS_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment RelationFields on Issue {
    relations(first: 250) {
      nodes {
        id
        type
        relatedIssue { id identifier title }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    inverseRelations(first: 250) {
      nodes {
        id
        type
        issue { id identifier title }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Linear's IssueFilter doesn't expose `identifier`, but `issue(id: ...)` accepts either
 * a UUID or a TEAM-NN identifier. Multi-alias query = one HTTP round-trip for N issues.
 *
 * Throws on empty `identifiers` — an empty selection set returns an invalid GraphQL
 * document that Linear rejects with an unhelpful error.
 */
export function buildPullIssuesQuery(
  identifiers: string[],
  withComments: boolean,
  withRelations = false,
): string {
  if (identifiers.length === 0) {
    throw new ValidationError(
      "buildPullIssuesQuery: cannot build a query with zero identifiers",
      "pass at least one TEAM-NN identifier to the pull fetch",
    );
  }
  const fragments = ["...IssueFields"];
  if (withComments) fragments.push("...CommentFields");
  if (withRelations) fragments.push("...RelationFields");
  const spread = fragments.join(" ");

  // Round-6 / CLI 17: accept either TEAM-NN identifiers OR UUIDs. Linear's
  // `issue(id:)` resolver takes both. Pre-fix we rejected UUIDs at the CLI
  // boundary even though the underlying API accepts them — that broke
  // copy-pasting issue UUIDs from Linear's URL/web app.
  const aliases = identifiers
    .map((id, i) => {
      const identifier = normalizeIssueIdentifierOrUuid(id, "issue identifier");
      return `  a${i}: issue(id: "${identifier}") { ${spread} }`;
    })
    .join("\n");
  return `
    query PullIssues {
    ${aliases}
    }
    ${ISSUE_FIELDS_FRAGMENT}
    ${withComments ? COMMENTS_FIELDS_FRAGMENT : ""}
    ${withRelations ? RELATIONS_FIELDS_FRAGMENT : ""}
  `;
}

/**
 * Continuation comments fetch for any issue whose multi-alias `comments`
 * fragment hit the 250-per-page cap. Use with `paginateRaw` and
 * `initialAfter` set to the original `pageInfo.endCursor`.
 */
export const MORE_COMMENTS_QUERY = /* GraphQL */ `
  query MoreComments($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      comments(first: $first, after: $after) {
        nodes {
          id
          body
          createdAt
          updatedAt
          user {
            id
            name
            email
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

/**
 * Project header (no issues sub-list). Pair with `PULL_PROJECT_ISSUES_QUERY`
 * to walk all child issues regardless of count.
 */
export const PULL_PROJECT_HEADER_QUERY = /* GraphQL */ `
  query PullProjectHeader($id: String!) {
    project(id: $id) {
      id
      name
      description
      content
      icon
      state
      startDate
      targetDate
      url
      updatedAt
    }
  }
`;

/**
 * Paginated issues-in-a-project query. Use with `paginateRaw` and a
 * `pageSize` ≤ 250 (Linear's per-request maximum).
 */
export const PULL_PROJECT_ISSUES_QUERY = /* GraphQL */ `
  query PullProjectIssues($id: String!, $first: Int!, $after: String) {
    project(id: $id) {
      issues(first: $first, after: $after) {
        nodes {
          identifier
          title
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export interface FetchedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  url: string;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  assignee: { id: string; name: string; email: string } | null;
  project: { id: string; name: string } | null;
  projectMilestone?: { id: string; name: string } | null;
  cycle?: { id: string; name: string } | null;
  team: { id: string; key: string };
  parent: { id: string; identifier: string } | null;
  labels: { nodes: { id: string; name: string }[] };
  comments?: {
    nodes: {
      id: string;
      body: string;
      createdAt: string;
      updatedAt: string;
      user: { id: string; name: string; email: string } | null;
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
  relations?: {
    nodes: {
      id: string;
      type: "blocks" | "duplicate" | "related" | "similar";
      relatedIssue: { id: string; identifier: string; title: string };
    }[];
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
  inverseRelations?: {
    nodes: {
      id: string;
      type: "blocks" | "duplicate" | "related" | "similar";
      issue: { id: string; identifier: string; title: string };
    }[];
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface FetchedProject {
  id: string;
  name: string;
  description: string;
  content: string | null;
  icon: string | null;
  state: string;
  startDate?: string | null;
  targetDate?: string | null;
  url: string;
  updatedAt: string;
  /** Populated by callers after paginating PULL_PROJECT_ISSUES_QUERY. */
  issues: { nodes: { identifier: string; title?: string }[] };
}

type IssueCommentNode = NonNullable<FetchedIssue["comments"]>["nodes"][number];

type MoreCommentsPage = {
  data?: {
    issue: {
      comments: {
        nodes: IssueCommentNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  };
};

export type IssueCommentsRawRequest = (
  query: string,
  variables: { id: string; first: number; after?: string },
) => Promise<MoreCommentsPage>;

type PullIssuesRawRequest = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<{ data?: Record<string, FetchedIssue | null> }>;

interface AliasError {
  message: string;
  path?: string[];
}

export interface HydrateIssuesResult {
  fetched: FetchedIssue[];
  errors: { identifier: string; error: string }[];
  metadata: {
    requested_count: number;
    fetched_count: number;
    failed_count: number;
    batch_size: number;
    batch_count: number;
    with_comments: boolean;
    with_relations: boolean;
    comments_completed: boolean;
  };
}

const DEFAULT_PULL_ISSUE_BATCH_SIZE_WITH_COMMENTS = 25;
const DEFAULT_PULL_ISSUE_BATCH_SIZE_WITH_RELATIONS = 20;
const DEFAULT_PULL_ISSUE_BATCH_SIZE_WITHOUT_COMMENTS = 75;
const DEFAULT_PULL_ISSUE_BATCH_CONCURRENCY = 3;
const DEFAULT_PULL_ISSUE_FALLBACK_CONCURRENCY = 4;

function issueHydrationBatchSize(withComments: boolean, withRelations: boolean): number {
  if (withRelations) return DEFAULT_PULL_ISSUE_BATCH_SIZE_WITH_RELATIONS;
  return withComments
    ? DEFAULT_PULL_ISSUE_BATCH_SIZE_WITH_COMMENTS
    : DEFAULT_PULL_ISSUE_BATCH_SIZE_WITHOUT_COMMENTS;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

/**
 * Shared bounded issue hydration for CLI pull and MCP pull tools.
 *
 * A single GraphQL query with hundreds of issue aliases can exceed Linear's
 * query-complexity budget. This keeps the one-call user experience while
 * splitting the underlying read into conservative alias batches and bounded
 * fallback requests when Linear rejects a mixed-success alias document.
 */
export async function hydrateIssuesBatched(
  rawRequest: PullIssuesRawRequest,
  identifiers: string[],
  options: {
    withComments: boolean;
    withRelations?: boolean;
    batchSize?: number;
    batchConcurrency?: number;
    fallbackConcurrency?: number;
    completeComments?: boolean;
  },
): Promise<HydrateIssuesResult> {
  const withRelations = options.withRelations === true;
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? issueHydrationBatchSize(options.withComments, withRelations)),
  );
  const batchConcurrency = options.batchConcurrency ?? DEFAULT_PULL_ISSUE_BATCH_CONCURRENCY;
  const fallbackConcurrency =
    options.fallbackConcurrency ?? DEFAULT_PULL_ISSUE_FALLBACK_CONCURRENCY;
  const idBatches = chunks(identifiers, batchSize);
  const batchResults = await mapLimit(idBatches, batchConcurrency, async (batch) =>
    rawRequestTolerant(
      rawRequest,
      batch,
      (ids) => buildPullIssuesQuery(ids, options.withComments, withRelations),
      fallbackConcurrency,
    ),
  );

  const fetched: FetchedIssue[] = [];
  const errors: { identifier: string; error: string }[] = [];
  for (let batchIndex = 0; batchIndex < idBatches.length; batchIndex++) {
    const batch = idBatches[batchIndex] ?? [];
    const result = batchResults[batchIndex];
    if (!result) continue;
    for (let i = 0; i < batch.length; i++) {
      const identifier = batch[i];
      if (!identifier) continue;
      const node = result.data[`a${i}`];
      if (node) {
        fetched.push(node);
        continue;
      }
      const aliasErr = result.errors.find((e) => e.path?.[0] === `a${i}`);
      const message = aliasErr
        ? rewriteNotFound(new Error(aliasErr.message), identifier).message
        : `not found: ${identifier}`;
      errors.push({ identifier, error: message });
    }
  }

  let commentsCompleted = false;
  if (options.withComments && options.completeComments !== false) {
    await completeInlineIssueComments(
      (query, variables) => rawRequest(query, variables) as Promise<MoreCommentsPage>,
      fetched,
    );
    commentsCompleted = true;
  }

  return {
    fetched,
    errors,
    metadata: {
      requested_count: identifiers.length,
      fetched_count: fetched.length,
      failed_count: errors.length,
      batch_size: batchSize,
      batch_count: idBatches.length,
      with_comments: options.withComments,
      with_relations: withRelations,
      comments_completed: commentsCompleted,
    },
  };
}

async function rawRequestTolerant(
  rawRequest: PullIssuesRawRequest,
  identifiers: string[],
  build: (ids: string[]) => string,
  fallbackConcurrency: number,
): Promise<{ data: Record<string, FetchedIssue | null>; errors: AliasError[] }> {
  try {
    const response = await withRetry(() => rawRequest(build(identifiers)));
    return { data: response.data ?? {}, errors: [] };
  } catch (_err) {
    const settled = await mapLimit(identifiers, fallbackConcurrency, async (identifier) => {
      try {
        const response = await withRetry(() => rawRequest(build([identifier])));
        return { ok: true as const, node: response.data?.a0 ?? null };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    });
    const data: Record<string, FetchedIssue | null> = {};
    const errors: AliasError[] = [];
    settled.forEach((result, i) => {
      const alias = `a${i}`;
      if (result.ok) {
        data[alias] = result.node;
      } else {
        data[alias] = null;
        errors.push({ path: [alias], message: result.error });
      }
    });
    return { data, errors };
  }
}

/**
 * Complete inline comment fragments from `buildPullIssuesQuery`.
 *
 * The multi-alias issue query intentionally fetches only the first 250
 * comments per issue. Call this before `buildComments()` so CLI/MCP pull
 * surfaces the same complete comment set for high-comment issues.
 */
export async function completeInlineIssueComments(
  rawRequest: IssueCommentsRawRequest,
  issues: FetchedIssue[],
): Promise<void> {
  const overflow = issues.filter((issue) => issue.comments?.pageInfo.hasNextPage);
  for (const issue of overflow) {
    const startCursor = issue.comments?.pageInfo.endCursor;
    if (!issue.comments) continue;
    if (!startCursor) {
      throw new ValidationError(
        `comments for ${issue.identifier} cannot continue`,
        "Linear returned hasNextPage without endCursor",
      );
    }
    const more = await paginateRaw<IssueCommentNode, MoreCommentsPage>(
      ({ first, after }) =>
        rawRequest(MORE_COMMENTS_QUERY, {
          id: issue.identifier,
          first,
          after,
        }),
      (response) => response.data?.issue?.comments ?? null,
      { pageSize: 250, initialAfter: startCursor },
    );
    issue.comments.nodes.push(...more);
    issue.comments.pageInfo.hasNextPage = false;
    issue.comments.pageInfo.endCursor = null;
  }
}
