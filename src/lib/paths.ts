import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LebopError } from "./errors.ts";
import { activeWorkspaceOverride } from "./requestContext.ts";

/**
 * Live path resolution for LEBOP_HOME-derived filesystem locations.
 * There are no process-load path snapshots — all FS I/O must go through
 * getters (`getLebopHome`, `getAuthFilePath`, `getConfigFilePath`,
 * `getCacheRoot`, `getContextRoot`, `getPublishReviewRoot`) so late
 * `LEBOP_HOME` env changes (e.g. tests) take effect.
 */
export function getLebopHome(): string {
  return process.env.LEBOP_HOME ?? join(homedir(), ".lebop");
}

/** Display path for auth credentials (not a real filesystem path). */
export const AUTH_FILE_DISPLAY = "LEBOP_HOME/auth.json";
export const AUTH_STORAGE_KIND = "lebop-home-auth-json";

/** Fallback segment when no workspace slug is resolvable (tests / pre-auth). */
export const UNSET_WORKSPACE_SLUG = "_unset";

const WORKSPACE_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function getAuthFilePath(): string {
  return join(getLebopHome(), "auth.json");
}

export function getConfigFilePath(): string {
  return join(getLebopHome(), "config.yaml");
}

export function getCacheRoot(): string {
  return join(getLebopHome(), "cache");
}

export function getContextRoot(): string {
  return join(getLebopHome(), "context");
}

export function getPublishReviewRoot(): string {
  return join(getLebopHome(), "publish-reviews");
}

/**
 * Sanitize a Linear workspace urlKey for use as a path segment.
 * Rejects path traversal; lowercases for stable keys.
 */
export function sanitizeWorkspaceSlug(slug: string | undefined | null): string {
  if (!slug || slug.trim() === "") return UNSET_WORKSPACE_SLUG;
  const trimmed = slug.trim();
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    !WORKSPACE_SLUG_PATTERN.test(trimmed)
  ) {
    return UNSET_WORKSPACE_SLUG;
  }
  return trimmed.toLowerCase();
}

/**
 * Sync peek of auth workspaces for path isolation (no migration side effects).
 * Returns null when auth is missing or unreadable — callers treat as pre-auth.
 */
export function peekAuthWorkspacesSync(): { default: string | null; slugs: string[] } | null {
  try {
    const authFile = getAuthFilePath();
    if (!existsSync(authFile)) return null;
    const raw = readFileSync(authFile, "utf8");
    const data = JSON.parse(raw) as {
      schema_version?: number;
      default?: string | null;
      workspaces?: Record<string, unknown>;
      token?: string;
    };
    if (data && typeof data === "object" && data.workspaces && typeof data.workspaces === "object") {
      const slugs = Object.keys(data.workspaces).filter(Boolean).sort();
      const def =
        typeof data.default === "string" && data.default.trim() !== ""
          ? data.default.trim()
          : null;
      return { default: def, slugs };
    }
    if (data && typeof data === "object" && typeof data.token === "string") {
      return { default: null, slugs: [] };
    }
    return null;
  } catch {
    return null;
  }
}

export interface ResolveWorkspaceSlugOptions {
  /**
   * When true (default), multi-ws with no selectable slug throws
   * `workspace_required` listing available slugs. When false, returns `_unset`.
   */
  failClosedMultiWs?: boolean;
}

/**
 * Resolve workspace slug for cache/context isolation (Lane 3 hybrid).
 *
 * Order: explicit → request context → LEBOP_WORKSPACE → auth.default →
 * single configured workspace → `_unset` (pre-auth) → fail-closed multi-ws.
 */
export function resolveWorkspaceSlugForState(
  explicit?: string | null,
  options: ResolveWorkspaceSlugOptions = {},
): string {
  const failClosed = options.failClosedMultiWs !== false;

  if (explicit) return sanitizeWorkspaceSlug(explicit);
  const fromCtx = activeWorkspaceOverride();
  if (fromCtx) return sanitizeWorkspaceSlug(fromCtx);
  const fromEnv = process.env.LEBOP_WORKSPACE;
  if (fromEnv) return sanitizeWorkspaceSlug(fromEnv);

  const auth = peekAuthWorkspacesSync();
  if (!auth || auth.slugs.length === 0) {
    return UNSET_WORKSPACE_SLUG;
  }

  if (auth.default) {
    const sanitized = sanitizeWorkspaceSlug(auth.default);
    if (sanitized !== UNSET_WORKSPACE_SLUG) {
      // Only use default when it still maps to a configured workspace key
      // (stale auth.default must not orphan cache/context under a dead slug).
      const keysLower = auth.slugs.map((s) => s.toLowerCase());
      if (keysLower.includes(sanitized) || auth.slugs.includes(auth.default)) {
        return sanitized;
      }
      // Fall through to single-ws / fail-closed multi-ws below.
    }
  }

  if (auth.slugs.length === 1) {
    return sanitizeWorkspaceSlug(auth.slugs[0]);
  }

  if (!failClosed) return UNSET_WORKSPACE_SLUG;

  const available = auth.slugs.join(", ");
  throw new LebopError(
    `multiple workspaces configured (${available}) but none selected for state paths`,
    "workspace_required",
    `pass --workspace <slug>, set LEBOP_WORKSPACE, or run \`lebop auth default <slug>\`. available: ${available}`,
    { available_workspaces: auth.slugs },
  );
}

/**
 * `~/.lebop/cache/<workspace-slug>/` when a workspace is known.
 * When unresolved (`_unset`), returns cache root for flat single-scope layout.
 */
export function workspaceCacheRoot(workspaceSlug?: string | null): string {
  const ws = sanitizeWorkspaceSlug(
    workspaceSlug !== undefined && workspaceSlug !== null
      ? workspaceSlug
      : resolveWorkspaceSlugForState(),
  );
  const root = getCacheRoot();
  if (ws === UNSET_WORKSPACE_SLUG) return root;
  return join(root, ws);
}

/**
 * `~/.lebop/context/<workspace-slug>/` when a workspace is known.
 */
export function workspaceContextRoot(workspaceSlug?: string | null): string {
  const ws = sanitizeWorkspaceSlug(
    workspaceSlug !== undefined && workspaceSlug !== null
      ? workspaceSlug
      : resolveWorkspaceSlugForState(),
  );
  const root = getContextRoot();
  if (ws === UNSET_WORKSPACE_SLUG) return root;
  return join(root, ws);
}
