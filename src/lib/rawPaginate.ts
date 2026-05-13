/**
 * Auto-paginate any GraphQL query that exposes one connection-shaped field
 * with `$first` + `$after` variables. Walks until the first connection's
 * `pageInfo.hasNextPage` goes false, accumulates all `nodes`, and returns
 * the merged result. Used by `lebop raw --paginate`.
 *
 * Pure aside from the injected `fetchPage` — caller closes over the query
 * and authenticated client. Makes this testable without HTTP.
 *
 * Works for queries shaped like:
 *   query Foo($first: Int!, $after: String) {
 *     someConnection(first: $first, after: $after) {
 *       nodes { ... }
 *       pageInfo { hasNextPage endCursor }
 *     }
 *   }
 *
 * Heuristic: scans the response's top-level `data.*` fields for one with
 * both `nodes` and `pageInfo`. The first match is paged; multiple
 * connections in one query aren't supported (the rest get only the first
 * page's worth).
 */

import { ValidationError } from "./errors.ts";

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ConnectionLike {
  nodes: unknown[];
  pageInfo: PageInfo;
}

type FetchPageFn = (vars: Record<string, unknown>) => Promise<{
  data: Record<string, unknown>;
}>;

const DEFAULT_PAGE_SIZE = 250;

export async function paginateRawQuery(
  initialVars: Record<string, unknown>,
  fetchPage: FetchPageFn,
): Promise<unknown> {
  const pageSize = (initialVars.first as number | undefined) ?? DEFAULT_PAGE_SIZE;
  let after: string | undefined = initialVars.after as string | undefined;
  const allNodes: unknown[] = [];
  let lastResponse: Record<string, unknown> | null = null;
  let connectionKey: string | null = null;

  while (true) {
    const vars = { ...initialVars, first: pageSize, after };
    const response = await fetchPage(vars);
    lastResponse = response.data;

    if (!connectionKey) {
      connectionKey = findConnectionKey(response.data);
      if (!connectionKey) {
        throw new ValidationError(
          "--paginate: no connection-shaped field found on the response. expected a top-level `data.X` with both `nodes` and `pageInfo`.",
          "the query must select a connection field (one with both `nodes` and `pageInfo`) at the top level",
        );
      }
    }

    const conn = response.data[connectionKey] as ConnectionLike;
    allNodes.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }

  if (lastResponse && connectionKey) {
    return {
      ...lastResponse,
      [connectionKey]: {
        ...(lastResponse[connectionKey] as object),
        nodes: allNodes,
      },
    };
  }
  return lastResponse;
}

/**
 * Find the first top-level field of `data` whose value is connection-shaped
 * (has both `nodes: any[]` and `pageInfo: object`). Pure; returns null if
 * none match.
 */
export function findConnectionKey(data: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(data)) {
    if (isConnection(v)) return k;
  }
  return null;
}

export function isConnection(value: unknown): value is ConnectionLike {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.nodes) && typeof v.pageInfo === "object" && v.pageInfo !== null;
}
