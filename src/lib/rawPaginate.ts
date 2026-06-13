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
import { resolveSafetyCap } from "./paginate.ts";

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
  const safetyCap = resolveSafetyCap();
  const seenCursors = new Set<string>();
  if (after) seenCursors.add(after);

  while (true) {
    const remaining = safetyCap - allNodes.length;
    if (remaining <= 0) {
      throwRawCapExceeded(safetyCap);
    }
    const vars = { ...initialVars, first: Math.min(pageSize, remaining), after };
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
    allNodes.push(...conn.nodes.slice(0, remaining));
    if (
      allNodes.length >= safetyCap &&
      (conn.pageInfo.hasNextPage || conn.nodes.length > remaining)
    ) {
      throwRawCapExceeded(safetyCap);
    }
    if (!conn.pageInfo.hasNextPage) break;
    const nextCursor = conn.pageInfo.endCursor;
    if (!nextCursor) {
      throw new ValidationError(
        `--paginate: connection "${connectionKey}" cannot continue because Linear returned hasNextPage without endCursor`,
        "retry the query; if it repeats, narrow the query or report the malformed Linear connection page",
      );
    }
    if (seenCursors.has(nextCursor)) {
      throw new ValidationError(
        `--paginate: repeated cursor "${nextCursor}" from connection "${connectionKey}"`,
        "check the query's after/endCursor wiring; the cursor did not advance",
      );
    }
    seenCursors.add(nextCursor);
    after = nextCursor;
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

function throwRawCapExceeded(cap: number): never {
  throw new ValidationError(
    `--paginate hit the safety cap of ${cap} items but the connection still reports more pages`,
    `set LEBOP_MAX_ITEMS=N (where N > ${cap}) to raise the ceiling, or pass a tighter GraphQL filter`,
  );
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
