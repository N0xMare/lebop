import { execSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LinearClient } from "@linear/sdk";
import { AuthError, LebopError, mapSdkError, ValidationError } from "./errors.ts";
import { AUTH_FILE, LEBOP_HOME } from "./paths.ts";
import { activeWorkspaceOverride } from "./requestContext.ts";
import { withRetry } from "./retry.ts";
import { authStateSafetyError, ensureLebopHomeForWrite } from "./stateSafety.ts";
import type { AuthFile, AuthFileV1, Viewer, WorkspaceAuth } from "./types.ts";

const AUTH_SCHEMA_VERSION = 2 as const;

/**
 * Load + return the multi-workspace auth file. Returns null when no auth
 * exists. Auto-migrates v1 (single workspace) to v2 (multi-workspace) on
 * first read and writes the migrated form back to disk.
 */
export async function loadAuth(): Promise<AuthFile | null> {
  const file = Bun.file(AUTH_FILE);
  if (!(await file.exists())) return null;
  secureExistingAuthForRead();
  let data: unknown;
  try {
    data = await file.json();
  } catch (err) {
    throw new AuthError(
      `failed to read ${AUTH_FILE}: ${(err as Error).message}`,
      "the file may be corrupted; run `lebop auth login` to recreate",
    );
  }

  if (isAuthFileV1(data)) {
    // Migrate in-memory: synthesize a workspace entry from the v1 fields.
    // The slug is unknown without an extra Linear call; fetch the
    // organization once to get the canonical urlKey, then write v2 back.
    const migrated = await migrateV1ToV2(data);
    await writeAuth(migrated);
    return migrated;
  }
  if (isAuthFileV2(data)) return data;

  throw new AuthError(
    `auth file at ${AUTH_FILE} has unexpected shape`,
    "run `lebop auth login` to recreate",
  );
}

function secureExistingAuthForRead(): void {
  try {
    const homeStat = lstatSync(LEBOP_HOME);
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
      throw new AuthError(
        `refusing to read auth from unsafe directory: ${LEBOP_HOME}`,
        "replace it with a normal directory owned by the current user",
      );
    }
    chmodSync(LEBOP_HOME, 0o700);

    const authStat = lstatSync(AUTH_FILE);
    if (authStat.isSymbolicLink() || !authStat.isFile()) {
      throw new AuthError(
        `refusing to read auth from unsafe file: ${AUTH_FILE}`,
        "replace it with a normal file, then run `lebop auth login` if needed",
      );
    }
    chmodSync(AUTH_FILE, 0o600);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError(
      `failed to secure auth file permissions: ${(err as Error).message}`,
      `set ${LEBOP_HOME} to mode 0700 and ${AUTH_FILE} to mode 0600, then retry`,
    );
  }
}

/**
 * Resolve which workspace's credentials to use for the current operation.
 * Selection order:
 *   1. Explicit `--workspace <slug>` arg (caller passes via `slug` here)
 *   2. `LEBOP_WORKSPACE` env var
 *   3. The auth file's `default`
 *   4. The single configured workspace if there's exactly one
 *
 * Throws AuthError when no auth exists, the requested slug isn't configured,
 * or there are multiple workspaces and none was specified.
 */
export async function loadAuthForWorkspace(slug?: string): Promise<WorkspaceAuth> {
  const auth = await loadAuth();
  if (!auth) {
    throw new AuthError("no Linear credentials found", "run `lebop auth login` first");
  }
  const slugs = Object.keys(auth.workspaces);
  if (slugs.length === 0) {
    throw new AuthError("no Linear credentials configured", "run `lebop auth login` first");
  }

  const requested =
    slug ?? activeWorkspaceOverride() ?? process.env.LEBOP_WORKSPACE ?? auth.default;
  if (requested) {
    const ws = auth.workspaces[requested];
    if (!ws) {
      throw new AuthError(
        `workspace "${requested}" is not configured`,
        `available: ${slugs.join(", ")} — run \`lebop auth login\` to add or \`lebop auth list\` to inspect`,
      );
    }
    return ws;
  }

  if (slugs.length === 1) {
    const only = auth.workspaces[slugs[0] as string];
    if (only) return only;
  }

  throw new AuthError(
    `multiple workspaces configured (${slugs.join(", ")}) but no default set`,
    "pass `--workspace <slug>`, set LEBOP_WORKSPACE, or run `lebop auth default <slug>`",
  );
}

/**
 * Add or replace a workspace in the auth file. Validates the token by
 * fetching `viewer + organization` (the org gives us the canonical urlKey
 * to use as the slug) before writing. Sets the new workspace as the default
 * if no default is currently set.
 */
export async function addWorkspace(token: string): Promise<WorkspaceAuth> {
  const probe = await probeToken(token);
  const ws: WorkspaceAuth = {
    slug: probe.urlKey,
    name: probe.orgName,
    url_key: probe.urlKey,
    token,
    viewer: probe.viewer,
    created_at: new Date().toISOString(),
  };

  const existing = (await loadAuth()) ?? {
    schema_version: AUTH_SCHEMA_VERSION,
    workspaces: {},
    default: undefined,
  };
  existing.workspaces[ws.slug] = ws;
  if (!existing.default) existing.default = ws.slug;
  existing.schema_version = AUTH_SCHEMA_VERSION;

  await writeAuth(existing);
  return ws;
}

/**
 * Remove one workspace by slug, or the entire auth file if no slug given
 * and there's exactly one (the legacy `lebop auth logout` shape). Returns
 * `true` if anything was removed.
 */
export async function removeWorkspace(slug?: string): Promise<boolean> {
  const auth = await loadAuth();
  if (!auth) return false;
  const slugs = Object.keys(auth.workspaces);

  if (!slug) {
    if (slugs.length === 0) {
      // No workspaces but file exists — nuke the file.
      if (existsSync(AUTH_FILE)) unlinkSync(AUTH_FILE);
      return !existsSync(AUTH_FILE);
    }
    if (slugs.length === 1) {
      // Legacy single-workspace logout: clear the file entirely.
      unlinkSync(AUTH_FILE);
      return true;
    }
    throw new AuthError(
      `multiple workspaces configured (${slugs.join(", ")}); pick one to log out`,
      "pass a slug: `lebop auth logout <slug>`",
    );
  }

  if (!auth.workspaces[slug]) return false;
  delete auth.workspaces[slug];
  if (auth.default === slug) {
    const remaining = Object.keys(auth.workspaces);
    auth.default = remaining[0];
  }
  if (Object.keys(auth.workspaces).length === 0) {
    unlinkSync(AUTH_FILE);
  } else {
    await writeAuth(auth);
  }
  return true;
}

/**
 * Set the default workspace. The slug must already be configured.
 */
export async function setDefaultWorkspace(slug: string): Promise<void> {
  const auth = await loadAuth();
  if (!auth) {
    throw new AuthError("no Linear credentials configured", "run `lebop auth login` first");
  }
  if (!auth.workspaces[slug]) {
    throw new AuthError(
      `workspace "${slug}" is not configured`,
      `available: ${Object.keys(auth.workspaces).join(", ")}`,
    );
  }
  auth.default = slug;
  await writeAuth(auth);
}

export function linearClientFromToken(token: string): LinearClient {
  // PAKs start with `lin_api_` and go in Authorization header as-is.
  // OAuth bearer tokens need the `Bearer ` prefix, which @linear/sdk adds for `accessToken`.
  // `LEBOP_API_URL` env var overrides the default Linear endpoint — used by
  // integration tests pointing at a local mock server.
  const apiUrl = resolveLinearApiUrlOverride();
  return token.startsWith("lin_api_")
    ? new LinearClient(apiUrl ? { apiKey: token, apiUrl } : { apiKey: token })
    : new LinearClient(apiUrl ? { accessToken: token, apiUrl } : { accessToken: token });
}

export function resolveLinearApiUrlOverride(): string | undefined {
  const apiUrl = process.env.LEBOP_API_URL?.trim();
  if (!apiUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new ValidationError(
      "LEBOP_API_URL must be a valid URL",
      "unset LEBOP_API_URL for real Linear calls, or point it at a local test server",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError(
      "LEBOP_API_URL must use http or https",
      "unset LEBOP_API_URL for real Linear calls, or point it at an HTTP(S) test server",
    );
  }
  if (isLocalLinearApiOverride(parsed)) return apiUrl;
  if (process.env.LEBOP_ALLOW_CUSTOM_API_URL === "1") return apiUrl;

  throw new ValidationError(
    "refusing to send Linear credentials to custom LEBOP_API_URL without LEBOP_ALLOW_CUSTOM_API_URL=1",
    "unset LEBOP_API_URL for real Linear calls, use a localhost test server, or set LEBOP_ALLOW_CUSTOM_API_URL=1 intentionally",
  );
}

function isLocalLinearApiOverride(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Validate a token by fetching viewer. Returns the viewer struct; throws
 * AuthError on auth failure or transient issue. Used during login flows.
 */
export async function validateToken(token: string): Promise<Viewer> {
  const probe = await probeToken(token);
  return probe.viewer;
}

export function importFromSchpet(): string {
  try {
    const token = execSync("linear auth token", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!token) {
      throw new AuthError(
        "`linear auth token` returned empty",
        "run `linear auth login` first to authenticate @schpet/linear-cli",
      );
    }
    return token;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const msg = (err as Error).message ?? String(err);
    throw new AuthError(
      `could not import from @schpet/linear-cli: ${msg}`,
      "install it (https://github.com/schpet/linear-cli) and run `linear auth login`, or use `lebop auth login` with a Linear personal API key",
    );
  }
}

// ---------- internal ----------

interface TokenProbe {
  viewer: Viewer;
  urlKey: string;
  orgName: string;
}

async function probeToken(token: string): Promise<TokenProbe> {
  const client = linearClientFromToken(token);
  try {
    // Idempotent reads — wrap with retry so transient 5xx during login don't
    // surface as misleading "token rejected" errors. `withRetry` already maps
    // non-retryable errors (auth, validation, not-found) through `mapSdkError`
    // before re-throwing, so a 401 here will already arrive as an AuthError.
    const viewer = await withRetry(() => client.viewer);
    const org = await withRetry(() => viewer.organization);
    return {
      viewer: { id: viewer.id, email: viewer.email, name: viewer.name },
      urlKey: org.urlKey,
      orgName: org.name,
    };
  } catch (err) {
    // Belt-and-suspenders: `probeToken` is called from login flows where
    // `linearClientFromToken` is used directly (NOT via `linear()`), so the
    // `installRawRequestMapping` wrapper from `sdk.ts` is not active here.
    // Route the raw error through `mapSdkError` so we still get a structured
    // AuthError / RateLimitError / etc. when the SDK throws.
    const mapped = err instanceof LebopError ? err : mapSdkError(err);

    if (mapped instanceof AuthError) {
      // Replace the generic mapped message with the login-flow-specific
      // wording (the original "token rejected" affordance points the user
      // at Settings → API rather than the more generic "run lebop auth
      // login" hint that `mapSdkError` attaches by default).
      throw new AuthError(
        "token rejected by Linear",
        "paste the full `lin_api_...` value from Settings → API",
      );
    }

    // Anything else that came back structured (RateLimitError, NotFoundError,
    // NetworkError, ValidationError) is more informative than the legacy
    // "failed to validate token" wrap, so propagate as-is.
    if (mapped instanceof LebopError) throw mapped;

    const msg = (err as Error).message ?? String(err);
    throw new AuthError(`failed to validate token: ${msg}`);
  }
}

async function migrateV1ToV2(v1: AuthFileV1): Promise<AuthFile> {
  // The v1 file stored token + viewer but no slug. Probe the organization
  // to recover the slug; if Linear is unreachable, fall back to a synthetic
  // slug derived from the viewer email so the file is still usable offline.
  let slug = "default";
  let orgName = "(unknown)";
  let urlKey = "";
  try {
    const probe = await probeToken(v1.token);
    slug = probe.urlKey;
    orgName = probe.orgName;
    urlKey = probe.urlKey;
  } catch {
    // Network unreachable — synthesize. User can re-login to fix the slug.
    slug = `legacy-${v1.viewer.id.slice(0, 8)}`;
    urlKey = slug;
  }
  return {
    schema_version: AUTH_SCHEMA_VERSION,
    workspaces: {
      [slug]: {
        slug,
        name: orgName,
        url_key: urlKey,
        token: v1.token,
        viewer: v1.viewer,
        created_at: v1.created_at,
      },
    },
    default: slug,
  };
}

async function writeAuth(auth: AuthFile): Promise<void> {
  // ~/.lebop/ must exist with mode 0700 before we drop any token-bearing tmp
  // file in it. mkdir's mode is ignored for an existing directory, so chmod
  // first and fail closed if the directory cannot be secured.
  ensureLebopHomeForWrite({ errorFactory: authStateSafetyError });
  await mkdir(dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
  try {
    chmodSync(LEBOP_HOME, 0o700);
  } catch (err) {
    throw new AuthError(
      `failed to secure auth directory permissions: ${(err as Error).message}`,
      `set ${LEBOP_HOME} to mode 0700, then retry`,
    );
  }

  const tmp = `${AUTH_FILE}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  try {
    await writeFile(tmp, `${JSON.stringify(auth, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(tmp, AUTH_FILE);
    chmodSync(AUTH_FILE, 0o600);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new AuthError(
      `failed to write auth file securely: ${(err as Error).message}`,
      `set ${LEBOP_HOME} to mode 0700 and ${AUTH_FILE} to mode 0600, then retry`,
    );
  }
}

function isAuthFileV1(value: unknown): value is AuthFileV1 {
  if (!isPlainRecord(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.schema_version !== 1) return false;
  if (typeof v.token !== "string") return false;
  if (typeof v.created_at !== "string") return false;
  const viewer = v.viewer as Record<string, unknown> | undefined;
  if (!isViewerRecord(viewer)) return false;
  return true;
}

function isAuthFileV2(value: unknown): value is AuthFile {
  if (!isPlainRecord(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.schema_version !== 2) return false;
  if (!isPlainRecord(v.workspaces)) return false;
  if (v.default !== undefined && typeof v.default !== "string") return false;
  const workspaces = v.workspaces as Record<string, unknown>;
  for (const [slug, record] of Object.entries(workspaces)) {
    if (!isWorkspaceAuthRecord(record)) return false;
    if ((record as WorkspaceAuth).slug !== slug) return false;
  }
  if (typeof v.default === "string" && !Object.hasOwn(workspaces, v.default)) return false;
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isViewerRecord(value: unknown): value is Viewer {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.email === "string" &&
    typeof value.name === "string"
  );
}

function isWorkspaceAuthRecord(value: unknown): value is WorkspaceAuth {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.slug === "string" &&
    typeof value.name === "string" &&
    typeof value.url_key === "string" &&
    typeof value.token === "string" &&
    isViewerRecord(value.viewer) &&
    typeof value.created_at === "string"
  );
}
