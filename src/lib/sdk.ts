import type { LinearClient } from "@linear/sdk";
import { linearClientFromToken, loadAuth } from "./auth.ts";
import { AuthError } from "./errors.ts";
import { withRetry } from "./retry.ts";

let _client: LinearClient | undefined;

export async function linear(): Promise<LinearClient> {
  if (_client) return _client;
  const auth = await loadAuth();
  if (!auth) {
    throw new AuthError("no Linear credentials found", "run `lebop auth login` first");
  }
  _client = linearClientFromToken(auth.token);
  return _client;
}

/**
 * Reset the cached LinearClient. Used by tests that switch credentials or API
 * URLs mid-process, and will be needed by the long-running MCP server (§13.3)
 * to react to per-request workspace switches and credential rotation.
 */
export function resetLinearClient(): void {
  _client = undefined;
}

/**
 * Run a Linear API call with automatic retry on transient errors (5xx) and
 * rate limits (429 / `extensions.code: RATELIMITED`). Use for **idempotent**
 * operations:
 *   - All reads (queries, list, fetch, single-entity get)
 *   - Updates that are idempotent at the value level (`issueUpdate`,
 *     `projectUpdate`)
 *   - Server-side-idempotent mutations (`issueRelationCreate` is idempotent
 *     at the `(issueId, relatedIssueId, type)` tuple per spec §12.1)
 *
 * For non-idempotent operations, call `linear()` directly:
 *   - `issueCreate` / `projectCreate` (retry-after-success would duplicate)
 *   - `issueArchive` (re-running a successful archive may surface as a
 *     spurious not-found)
 *   - `issueRelationDelete` by UUID (same — gone after first success)
 *   - `addComment` (would post a duplicate)
 */
export async function withClient<T>(fn: (client: LinearClient) => Promise<T>): Promise<T> {
  const client = await linear();
  return withRetry(() => fn(client));
}
