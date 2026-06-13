import type { LinearClient } from "@linear/sdk";
import { linearClientFromToken, loadAuthForWorkspace } from "./auth.ts";
import { mapSdkError } from "./errors.ts";
import {
  observeLinearRateLimitError,
  observeLinearRateLimitHeaders,
  recordLinearApiAttempt,
} from "./rateLimit.ts";
import { withRetry } from "./retry.ts";

// Per-workspace client cache. Calls to `linear()` resolve to the same
// LinearClient across the process for a given workspace slug; switching
// workspaces just looks up a different cached entry.
const _clients = new Map<string, LinearClient>();

/**
 * Wrap `client.client.rawRequest` and `client.client.request` so every Linear
 * response feeds rate-limit telemetry. Idempotent: re-wrapping is a no-op
 * because we tag the bound methods on first install.
 *
 * `rawRequest` callers also get structured error mapping here. Generated SDK
 * model methods go through `request`, and the SDK's `LinearClient` wraps that
 * with its own `parseLinearError` catch; do not map those errors early or the
 * SDK will re-wrap the mapped LebopError as an unknown Linear error.
 */
const WRAPPED = Symbol.for("lebop.linearTransportWrapped");
function installLinearTransportHooks(client: LinearClient, workspace: string): void {
  const inner = client.client as unknown as {
    rawRequest: (...args: unknown[]) => Promise<unknown>;
    request: (...args: unknown[]) => Promise<unknown>;
    [WRAPPED]?: boolean;
  };
  if (inner[WRAPPED]) return;
  const originalRawRequest = inner.rawRequest.bind(inner);
  const originalRequest = inner.request.bind(inner);
  inner.rawRequest = async (...args: unknown[]) => {
    recordLinearApiAttempt(workspace);
    try {
      const response = await originalRawRequest(...args);
      observeLinearRateLimitHeaders(
        workspace,
        (response as { headers?: Headers | Record<string, unknown> } | undefined)?.headers,
      );
      return response;
    } catch (err) {
      observeLinearRateLimitError(workspace, err);
      throw mapSdkError(err);
    }
  };
  inner.request = async (...args: unknown[]) => {
    const query = args[0];
    if (typeof query !== "string") {
      // Preserve SDK behavior for uncommon direct request(DocumentNode) usage.
      recordLinearApiAttempt(workspace);
      try {
        return await originalRequest(...args);
      } catch (err) {
        observeLinearRateLimitError(workspace, err);
        throw err;
      }
    }
    recordLinearApiAttempt(workspace);
    try {
      const response = (await originalRawRequest(...args)) as { data?: unknown; headers?: Headers };
      observeLinearRateLimitHeaders(workspace, response.headers);
      return response.data;
    } catch (err) {
      observeLinearRateLimitError(workspace, err);
      throw err;
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
    installLinearTransportHooks(client, auth.slug);
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
