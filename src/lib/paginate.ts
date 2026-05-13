/**
 * Generic Relay-style cursor pagination. Linear's GraphQL API caps `first` at
 * 250 per request for most connections, so any "list everything" call needs
 * to walk pages until `pageInfo.hasNextPage` goes false.
 *
 * Two helpers:
 *   - `paginateConnection` for SDK calls (`client.issues({filter, first, after})`)
 *   - `paginateRaw` for raw GraphQL queries with cursor variables
 *
 * Both support a `max` cap (default 10_000, configurable via `LEBOP_MAX_ITEMS`)
 * so a runaway query can't pull the entire workspace into memory by accident,
 * and a `pageSize` (default 250 — Linear's per-request maximum).
 *
 * When a walk crosses 50% of the resolved cap, a one-shot warning is emitted
 * to stderr so callers know they're approaching the safety limit. When the
 * cap is actually hit (out.length >= max while the connection still reports
 * `hasNextPage`), a `ValidationError` is thrown with a hint to raise
 * `LEBOP_MAX_ITEMS`. Callers who pass an explicit `max` opt in to that bound
 * intentionally and get no warning / no throw at that boundary.
 *
 * Each page request is wrapped with `withRetry` so transient 5xx errors and
 * 429 rate limits are handled automatically.
 */

import { ValidationError } from "./errors.ts";
import { withRetry } from "./retry.ts";

// 250 is Linear's per-request maximum for most connections. Almost every
// caller bumps the default to 250 explicitly anyway; making it the default
// halves the round-trip count on common list operations.
const DEFAULT_PAGE_SIZE = 250;
const DEFAULT_SAFETY_CAP = 10_000;

/**
 * Resolve the runtime safety cap from `LEBOP_MAX_ITEMS`, falling back to
 * 10_000. Read on each call so tests can override per-case without process
 * restart and so MCP server invocations pick up env changes between tools.
 * Invalid values (non-numeric, NaN, <= 0) fall back to the default — we don't
 * throw here because the caller may not have control over the environment.
 */
export function resolveSafetyCap(): number {
  const raw = process.env.LEBOP_MAX_ITEMS;
  if (raw === undefined || raw === "") return DEFAULT_SAFETY_CAP;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SAFETY_CAP;
  return n;
}

export interface PaginateOpts {
  /** Items per request. Linear's per-request maximum is 250. Default 250. */
  pageSize?: number;
  /**
   * Hard cap on total items returned. Default resolves from `LEBOP_MAX_ITEMS`
   * (or 10_000) — set Number.POSITIVE_INFINITY to disable. Explicit values
   * suppress the threshold-approaching warning and cap-exceeded throw; only
   * the runtime safety cap surfaces those signals.
   */
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
 * One-shot warning emitter for the "approaching the safety cap" signal.
 * Lib normally avoids stderr writes (errors are thrown as structured
 * LebopErrors), but this is a soft signal that doesn't fit the error
 * taxonomy — and the message must reach the operator before the walk
 * completes. The emit is gated on a module-local flag so each `lebop`
 * process logs at most once per safety-cap threshold cross.
 */
let _warnedApproachingCap = false;
function maybeWarnApproachingCap(accumulated: number, cap: number): void {
  if (_warnedApproachingCap) return;
  if (accumulated < cap / 2) return;
  _warnedApproachingCap = true;
  // stderr.write avoids the implicit newline that console.warn adds in some
  // environments, keeping the format consistent with the rest of the CLI's
  // warning lines.
  process.stderr.write(
    `warning: paginated walk has accumulated ${accumulated} items — approaching the safety cap of ${cap}. ` +
      `Set LEBOP_MAX_ITEMS=N to raise the ceiling, or pass a tighter filter.\n`,
  );
}

/**
 * Exported for tests so each case starts from a clean warning state.
 * Not for production use.
 *
 * @internal — test-only helper; the `_` prefix + this annotation signal
 * "don't import from production code paths". Round-6 / L2.
 */
export function _resetPaginateWarningState(): void {
  _warnedApproachingCap = false;
}

function throwCapExceeded(cap: number): never {
  throw new ValidationError(
    `paginated walk hit the safety cap of ${cap} items but the connection still reports more pages`,
    `set LEBOP_MAX_ITEMS=N (where N > ${cap}) to raise the ceiling, or pass a tighter filter`,
  );
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
  const safetyCap = resolveSafetyCap();
  const explicitMax = opts.max !== undefined;
  const max = opts.max ?? safetyCap;
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
    if (!explicitMax) maybeWarnApproachingCap(out.length, safetyCap);
    if (out.length >= max) {
      // Implicit safety-cap hit AND the server says there's still more →
      // surface a hard error so the caller doesn't silently consume a
      // partial set. Explicit max caps are intentional; respect them.
      if (!explicitMax && page.pageInfo.hasNextPage) throwCapExceeded(safetyCap);
      break;
    }
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
  const safetyCap = resolveSafetyCap();
  const explicitMax = opts.max !== undefined;
  const max = opts.max ?? safetyCap;
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
    if (!explicitMax) maybeWarnApproachingCap(out.length, safetyCap);
    if (out.length >= max) {
      if (!explicitMax && conn.pageInfo.hasNextPage) throwCapExceeded(safetyCap);
      break;
    }
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }

  return out.slice(0, max);
}
