import type { LinearClient } from "@linear/sdk";
import { linearClientFromToken, loadAuthForWorkspace } from "./auth.ts";
import { withRetry } from "./retry.ts";

// Per-workspace client cache. Calls to `linear()` resolve to the same
// LinearClient across the process for a given workspace slug; switching
// workspaces just looks up a different cached entry.
const _clients = new Map<string, LinearClient>();

/**
 * Resolve the LinearClient for a specific workspace, or for the default
 * workspace when no slug is given. Caches per-slug for the process lifetime.
 *
 * Selection order matches `loadAuthForWorkspace`:
 *   1. Explicit `workspace` arg
 *   2. `LEBOP_WORKSPACE` env var
 *   3. The auth file's `default`
 *   4. The single configured workspace if there's exactly one
 */
export async function linear(workspace?: string): Promise<LinearClient> {
  const auth = await loadAuthForWorkspace(workspace);
  let client = _clients.get(auth.slug);
  if (!client) {
    client = linearClientFromToken(auth.token);
    _clients.set(auth.slug, client);
  }
  return client;
}

/**
 * Reset the cached LinearClients. Used by tests that switch credentials or
 * API URLs mid-process, and by the long-running MCP server (§13.3) for
 * credential rotation.
 */
export function resetLinearClient(): void {
  _clients.clear();
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
 *
 * Pass `workspace` to target a specific workspace; defaults to the resolved
 * default per the auth file.
 */
export async function withClient<T>(
  fn: (client: LinearClient) => Promise<T>,
  workspace?: string,
): Promise<T> {
  const client = await linear(workspace);
  return withRetry(() => fn(client));
}
