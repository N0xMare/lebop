import type { LinearClient } from "@linear/sdk";
import { linearClientFromToken, loadAuthForWorkspace } from "./auth.ts";
import { mapSdkError } from "./errors.ts";
import { withRetry } from "./retry.ts";

// Per-workspace client cache. Calls to `linear()` resolve to the same
// LinearClient across the process for a given workspace slug; switching
// workspaces just looks up a different cached entry.
const _clients = new Map<string, LinearClient>();

/**
 * Wrap `client.client.rawRequest` so every error thrown by the GraphQL
 * transport is mapped through `mapSdkError` into a structured LebopError
 * subtype at the SDK boundary. Idempotent: re-wrapping is a no-op because
 * we tag the bound method on first install.
 *
 * This catches non-retry-wrapped callers (mutations like `issueCreate`,
 * `projectCreate`, archive/delete) too. Retry-wrapped callers also get
 * mapping in `withRetry`'s non-retryable branch, but mapping at the
 * transport layer ensures even unwrapped paths surface structured errors.
 */
const WRAPPED = Symbol.for("lebop.rawRequestWrapped");
function installRawRequestMapping(client: LinearClient): void {
  const inner = client.client as unknown as {
    rawRequest: (...args: unknown[]) => Promise<unknown>;
    [WRAPPED]?: boolean;
  };
  if (inner[WRAPPED]) return;
  const original = inner.rawRequest.bind(inner);
  inner.rawRequest = async (...args: unknown[]) => {
    try {
      return await original(...args);
    } catch (err) {
      throw mapSdkError(err);
    }
  };
  inner[WRAPPED] = true;
}

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
    installRawRequestMapping(client);
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
