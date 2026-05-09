/**
 * Generic Relay-style cursor pagination. Linear's GraphQL API caps `first` at
 * 250 per request for most connections, so any "list everything" call needs
 * to walk pages until `pageInfo.hasNextPage` goes false.
 *
 * Two helpers:
 *   - `paginateConnection` for SDK calls (`client.issues({filter, first, after})`)
 *   - `paginateRaw` for raw GraphQL queries with cursor variables
 *
 * Both support a `max` cap (default 10_000) so a runaway query can't pull
 * the entire workspace into memory by accident, and a `pageSize` (default
 * 250 — Linear's per-request maximum).
 *
 * Each page request is wrapped with `withRetry` so transient 5xx errors and
 * 429 rate limits are handled automatically.
 */

import { withRetry } from "./retry.ts";

// 250 is Linear's per-request maximum for most connections. Almost every
// caller bumps the default to 250 explicitly anyway; making it the default
// halves the round-trip count on common list operations.
const DEFAULT_PAGE_SIZE = 250;
const SAFETY_CAP = 10_000;

export interface PaginateOpts {
  /** Items per request. Linear's per-request maximum is 250. Default 250. */
  pageSize?: number;
  /** Hard cap on total items returned. Default 10_000 — set Number.POSITIVE_INFINITY to disable. */
  max?: number;
  /**
   * Cursor to start from. Useful when continuing a partial paginated read —
   * e.g. the multi-alias issue query returned the first page of comments
   * inline, and you want to fetch the rest starting from its `endCursor`.
   * Default undefined (start from the beginning).
   */
  initialAfter?: string;
}

interface PageInfo {
  hasNextPage: boolean;
  // Linear's SDK types this as `string | null | undefined`; raw GraphQL responses
  // give `string | null`. Accept both.
  endCursor?: string | null;
}

interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
}

/**
 * Walk an SDK-style connection to completion (or up to `max` items).
 *
 * The fetcher receives `{first, after}` and returns the connection. Both
 * `IssueConnection`, `ProjectConnection`, etc. from `@linear/sdk` are
 * structurally compatible with the `Connection<T>` shape.
 */
export async function paginateConnection<T>(
  fetchPage: (args: { first: number; after?: string }) => Promise<Connection<T>>,
  opts: PaginateOpts = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const max = opts.max ?? SAFETY_CAP;
  const out: T[] = [];
  let after: string | undefined = opts.initialAfter;

  while (out.length < max) {
    const remaining = max - out.length;
    const first = Math.min(pageSize, remaining);
    const page = await withRetry(() =>
      fetchPage(after === undefined ? { first } : { first, after }),
    );
    // Defensive clamp: even if the server returns more nodes than `first`
    // requested (shouldn't happen but observed across other GraphQL APIs),
    // never exceed `max` overall.
    out.push(...page.nodes.slice(0, max - out.length));
    if (out.length >= max) break;
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
  }

  return out.slice(0, max);
}

/**
 * Walk a raw GraphQL paginated query. The fetcher runs the request with
 * `{first, after}` and returns whatever the response shape is; `pickConnection`
 * extracts the `{nodes, pageInfo}` connection from inside that response.
 *
 * Returning `null` from `pickConnection` (e.g. parent entity not found)
 * stops walking and returns whatever was accumulated so far.
 */
export async function paginateRaw<T, R>(
  fetchPage: (args: { first: number; after?: string }) => Promise<R>,
  pickConnection: (response: R) => Connection<T> | null,
  opts: PaginateOpts = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const max = opts.max ?? SAFETY_CAP;
  const out: T[] = [];
  let after: string | undefined = opts.initialAfter;

  while (out.length < max) {
    const remaining = max - out.length;
    const first = Math.min(pageSize, remaining);
    const response = await withRetry(() =>
      fetchPage(after === undefined ? { first } : { first, after }),
    );
    const conn = pickConnection(response);
    if (!conn) break;
    out.push(...conn.nodes.slice(0, max - out.length));
    if (out.length >= max) break;
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }

  return out.slice(0, max);
}
