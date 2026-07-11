import { z } from "zod";
import {
  addWorkspace,
  loadAuth,
  loadAuthForWorkspace,
  removeWorkspace,
  setDefaultWorkspace,
  validateToken,
} from "../lib/auth.ts";
import { setWorkspaceDefaultTeam } from "../lib/configWrite.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import { AUTH_FILE_DISPLAY, AUTH_STORAGE_KIND } from "../lib/paths.ts";
import { runWithRequestContext } from "../lib/requestContext.ts";
import { getTeam } from "../lib/teams.ts";
import type { Viewer, WorkspaceAuth } from "../lib/types.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput } from "./schema.ts";

// ---------------------------------------------------------------------------
// Shared records / payloads
// ---------------------------------------------------------------------------

export interface ListedWorkspaceRecord {
  slug: string;
  name: string;
  url_key: string;
  viewer: Viewer;
  created_at: string;
  is_default: boolean;
}

export interface ListWorkspacesResult {
  auth_file: string;
  auth_storage: string;
  default: string | null;
  workspaces: ListedWorkspaceRecord[];
}

export interface WhoamiResult {
  workspace: string;
  workspace_name: string;
  is_default: boolean;
  viewer: Viewer;
  auth_file: string;
  auth_storage: string;
  refreshed: boolean;
  created_at: string;
}

export interface SetDefaultWorkspaceResult {
  default: string;
}

export interface SetWorkspaceDefaultTeamResult {
  workspace_slug: string;
  team: string;
}

export interface AuthLoginResult {
  workspace: WorkspaceAuth;
}

export interface AuthLogoutResult {
  removed: boolean;
  /** Present when a specific slug was requested. */
  slug?: string;
}

export interface AuthTokenResult {
  /** Full token when unsafe; masked preview otherwise. */
  value: string;
  unsafe: boolean;
  /** True when value is the full secret. */
  is_full_token: boolean;
}

// ---------------------------------------------------------------------------
// Canonical inputs
// ---------------------------------------------------------------------------

export type ListWorkspacesInput = Record<string, never>;
export type ListWorkspacesCliInput = Record<string, never>;
export type ListWorkspacesMcpInput = Record<string, unknown>;

export interface SetDefaultWorkspaceInput {
  slug: string;
}

export interface SetDefaultWorkspaceCliInput {
  slug: string;
}

export type SetDefaultWorkspaceMcpInput = Record<string, unknown> & {
  slug: string;
};

export interface WhoamiInput {
  forWorkspace?: string;
}

export interface WhoamiCliInput {
  slug?: string;
}

export type WhoamiMcpInput = Record<string, unknown> & {
  for_workspace?: string;
  workspace?: string;
};

export interface RefreshWhoamiInput {
  forWorkspace?: string;
  /** CLI re-validates then re-adds; MCP re-adds and uses refreshed metadata. */
  channel: "cli" | "mcp";
}

export interface RefreshWhoamiCliInput {
  slug?: string;
}

export type RefreshWhoamiMcpInput = Record<string, unknown> & {
  for_workspace?: string;
  workspace?: string;
};

export interface SetWorkspaceDefaultTeamInput {
  workspaceSlug: string;
  team: string;
  /**
   * CLI writes the resolved team key; MCP writes the caller-provided team
   * string (behavior freeze).
   */
  writeCanonicalKey: boolean;
}

export interface SetWorkspaceDefaultTeamCliInput {
  workspace: string;
  team: string;
}

export type SetWorkspaceDefaultTeamMcpInput = Record<string, unknown> & {
  workspace_slug: string;
  team: string;
};

export interface SetWorkspaceDefaultTeamDeps {
  teamNotFoundHint: string;
}

export interface AuthLoginInput {
  token: string;
}

export interface AuthLoginCliInput {
  token: string;
}

export interface AuthLogoutInput {
  slug?: string;
}

export interface AuthLogoutCliInput {
  slug?: string;
}

export interface AuthTokenInput {
  slug?: string;
  unsafe?: boolean;
}

export interface AuthTokenCliInput {
  slug?: string;
  unsafe?: boolean;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listWorkspacesCanonicalSchema = z.object({}).strict();

const setDefaultWorkspaceCanonicalSchema = z
  .object({
    slug: z.string().min(1),
  })
  .strict();

const whoamiCanonicalSchema = z
  .object({
    forWorkspace: z.string().optional(),
  })
  .strict();

const refreshWhoamiCanonicalSchema = z
  .object({
    forWorkspace: z.string().optional(),
    channel: z.enum(["cli", "mcp"]),
  })
  .strict();

const setWorkspaceDefaultTeamCanonicalSchema = z
  .object({
    workspaceSlug: z.string().min(1),
    team: z.string().min(1),
    writeCanonicalKey: z.boolean(),
  })
  .strict();

const authLoginCanonicalSchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();

const authLogoutCanonicalSchema = z
  .object({
    slug: z.string().optional(),
  })
  .strict();

const authTokenCanonicalSchema = z
  .object({
    slug: z.string().optional(),
    unsafe: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildListWorkspacesInputFromCli(
  _input?: ListWorkspacesCliInput,
): ListWorkspacesInput {
  return parseSurfaceInput("auth.list_workspaces", listWorkspacesCanonicalSchema, {});
}

export function buildListWorkspacesInputFromMcp(
  _input?: ListWorkspacesMcpInput,
): ListWorkspacesInput {
  return parseSurfaceInput("auth.list_workspaces", listWorkspacesCanonicalSchema, {});
}

export function buildSetDefaultWorkspaceInputFromCli(
  input: SetDefaultWorkspaceCliInput,
): SetDefaultWorkspaceInput {
  return parseSurfaceInput("auth.set_default_workspace", setDefaultWorkspaceCanonicalSchema, {
    slug: input.slug,
  });
}

export function buildSetDefaultWorkspaceInputFromMcp(
  input: SetDefaultWorkspaceMcpInput,
): SetDefaultWorkspaceInput {
  return parseSurfaceInput("auth.set_default_workspace", setDefaultWorkspaceCanonicalSchema, {
    slug: input.slug,
  });
}

export function buildWhoamiInputFromCli(input: WhoamiCliInput): WhoamiInput {
  return parseSurfaceInput("auth.whoami", whoamiCanonicalSchema, {
    forWorkspace: input.slug,
  });
}

export function buildWhoamiInputFromMcp(input: WhoamiMcpInput): WhoamiInput {
  return parseSurfaceInput("auth.whoami", whoamiCanonicalSchema, {
    forWorkspace: input.for_workspace,
  });
}

export function buildRefreshWhoamiInputFromCli(input: RefreshWhoamiCliInput): RefreshWhoamiInput {
  return parseSurfaceInput("auth.refresh_whoami", refreshWhoamiCanonicalSchema, {
    forWorkspace: input.slug,
    channel: "cli",
  });
}

export function buildRefreshWhoamiInputFromMcp(input: RefreshWhoamiMcpInput): RefreshWhoamiInput {
  return parseSurfaceInput("auth.refresh_whoami", refreshWhoamiCanonicalSchema, {
    forWorkspace: input.for_workspace,
    channel: "mcp",
  });
}

export function buildSetWorkspaceDefaultTeamInputFromCli(
  input: SetWorkspaceDefaultTeamCliInput,
): SetWorkspaceDefaultTeamInput {
  return parseSurfaceInput(
    "auth.set_workspace_default_team",
    setWorkspaceDefaultTeamCanonicalSchema,
    {
      workspaceSlug: input.workspace,
      team: input.team,
      writeCanonicalKey: true,
    },
  );
}

export function buildSetWorkspaceDefaultTeamInputFromMcp(
  input: SetWorkspaceDefaultTeamMcpInput,
): SetWorkspaceDefaultTeamInput {
  return parseSurfaceInput(
    "auth.set_workspace_default_team",
    setWorkspaceDefaultTeamCanonicalSchema,
    {
      workspaceSlug: input.workspace_slug,
      team: input.team,
      writeCanonicalKey: false,
    },
  );
}

export function buildAuthLoginInputFromCli(input: AuthLoginCliInput): AuthLoginInput {
  return parseSurfaceInput("auth.login", authLoginCanonicalSchema, {
    token: input.token,
  });
}

export function buildAuthLogoutInputFromCli(input: AuthLogoutCliInput): AuthLogoutInput {
  return parseSurfaceInput("auth.logout", authLogoutCanonicalSchema, {
    slug: input.slug,
  });
}

export function buildAuthTokenInputFromCli(input: AuthTokenCliInput): AuthTokenInput {
  return parseSurfaceInput("auth.token", authTokenCanonicalSchema, {
    slug: input.slug,
    unsafe: input.unsafe,
  });
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function executeListWorkspaces(
  _input: ListWorkspacesInput = {},
): Promise<ListWorkspacesResult> {
  const stored = await loadAuth();
  if (!stored) {
    return {
      auth_file: AUTH_FILE_DISPLAY,
      auth_storage: AUTH_STORAGE_KIND,
      default: null,
      workspaces: [],
    };
  }
  const slugs = Object.keys(stored.workspaces);
  const workspaces = slugs
    .map((s) => {
      const ws = stored.workspaces[s];
      if (!ws) return null;
      return {
        slug: ws.slug,
        name: ws.name,
        url_key: ws.url_key,
        viewer: ws.viewer,
        created_at: ws.created_at,
        is_default: stored.default === ws.slug,
      };
    })
    .filter((row): row is ListedWorkspaceRecord => Boolean(row));

  return {
    auth_file: AUTH_FILE_DISPLAY,
    auth_storage: AUTH_STORAGE_KIND,
    default: stored.default ?? null,
    workspaces,
  };
}

export function listWorkspacesPayload(result: ListWorkspacesResult) {
  return {
    auth_file: result.auth_file,
    auth_storage: result.auth_storage,
    default: result.default,
    workspaces: result.workspaces,
  };
}

/** CLI `auth default` no-arg JSON shape (default field only). */
export function authDefaultReadPayload(result: ListWorkspacesResult) {
  return { default: result.default };
}

export async function executeSetDefaultWorkspace(
  input: SetDefaultWorkspaceInput,
): Promise<SetDefaultWorkspaceResult> {
  // Note: CLI adapter may pre-check for a friendlier "no credentials stored"
  // message; MCP calls setDefaultWorkspace directly (behavior freeze).
  await setDefaultWorkspace(input.slug);
  return { default: input.slug };
}

export function setDefaultWorkspacePayload(result: SetDefaultWorkspaceResult) {
  return { default: result.default };
}

export async function executeWhoami(input: WhoamiInput): Promise<WhoamiResult> {
  const ws = await loadAuthForWorkspace(input.forWorkspace);
  const fullAuth = await loadAuth();
  const isDefault = fullAuth?.default === ws.slug;
  return {
    workspace: ws.slug,
    workspace_name: ws.name,
    is_default: isDefault,
    viewer: ws.viewer,
    auth_file: AUTH_FILE_DISPLAY,
    auth_storage: AUTH_STORAGE_KIND,
    refreshed: false,
    created_at: ws.created_at,
  };
}

export async function executeRefreshWhoami(input: RefreshWhoamiInput): Promise<WhoamiResult> {
  const ws = await loadAuthForWorkspace(input.forWorkspace);

  if (input.channel === "cli") {
    // Behavior freeze: CLI re-validates, then re-adds, but keeps the pre-refresh
    // workspace metadata (slug/name/created_at) in the response.
    const viewer = await validateToken(ws.token);
    await addWorkspace(ws.token);
    const fullAuth = await loadAuth();
    const isDefault = fullAuth?.default === ws.slug;
    return {
      workspace: ws.slug,
      workspace_name: ws.name,
      is_default: isDefault,
      viewer,
      auth_file: AUTH_FILE_DISPLAY,
      auth_storage: AUTH_STORAGE_KIND,
      refreshed: true,
      created_at: ws.created_at,
    };
  }

  // MCP: re-add and surface the refreshed WorkspaceAuth row.
  const refreshed = await addWorkspace(ws.token);
  const fullAuth = await loadAuth();
  const isDefault = fullAuth?.default === refreshed.slug;
  return {
    workspace: refreshed.slug,
    workspace_name: refreshed.name,
    is_default: isDefault,
    viewer: refreshed.viewer,
    auth_file: AUTH_FILE_DISPLAY,
    auth_storage: AUTH_STORAGE_KIND,
    refreshed: true,
    created_at: refreshed.created_at,
  };
}

export function whoamiPayload(result: WhoamiResult) {
  return {
    workspace: result.workspace,
    workspace_name: result.workspace_name,
    is_default: result.is_default,
    viewer: result.viewer,
    auth_file: result.auth_file,
    auth_storage: result.auth_storage,
    refreshed: result.refreshed,
    created_at: result.created_at,
  };
}

export async function executeSetWorkspaceDefaultTeam(
  input: SetWorkspaceDefaultTeamInput,
  deps: SetWorkspaceDefaultTeamDeps,
): Promise<SetWorkspaceDefaultTeamResult> {
  let resolvedTeamKey = input.team;
  await runWithRequestContext({ workspace: input.workspaceSlug }, async () => {
    const team = await getTeam(input.team);
    if (!team) {
      throw new NotFoundError(`team not found: ${input.team}`, deps.teamNotFoundHint);
    }
    resolvedTeamKey = team.key;
  });

  // Behavior freeze: CLI persists canonical key; MCP persists caller string.
  const teamToWrite = input.writeCanonicalKey ? resolvedTeamKey : input.team;
  await setWorkspaceDefaultTeam(input.workspaceSlug, teamToWrite);
  return {
    workspace_slug: input.workspaceSlug,
    team: teamToWrite,
  };
}

export function setWorkspaceDefaultTeamPayload(result: SetWorkspaceDefaultTeamResult) {
  return {
    workspace_slug: result.workspace_slug,
    team: result.team,
  };
}

export async function executeAuthLogin(input: AuthLoginInput): Promise<AuthLoginResult> {
  if (!input.token) {
    throw new ValidationError(
      "no token provided",
      "pass --token, --token-file, --from-schpet, or enter a token at the prompt",
    );
  }
  const workspace = await addWorkspace(input.token);
  return { workspace };
}

export async function executeAuthLogout(input: AuthLogoutInput): Promise<AuthLogoutResult> {
  const removed = await removeWorkspace(input.slug);
  return { removed, slug: input.slug };
}

export function maskAuthToken(token: string): string {
  const tail = token.slice(-4);
  const sepIdx = token.indexOf("_", 4);
  const head = sepIdx > 0 ? token.slice(0, sepIdx + 1) : token.slice(0, 8);
  const hidden = "*".repeat(Math.max(4, token.length - head.length - tail.length));
  return `${head}${hidden}${tail}`;
}

export async function executeAuthToken(input: AuthTokenInput): Promise<AuthTokenResult> {
  const ws = await loadAuthForWorkspace(input.slug);
  if (input.unsafe) {
    return { value: ws.token, unsafe: true, is_full_token: true };
  }
  return {
    value: maskAuthToken(ws.token),
    unsafe: false,
    is_full_token: false,
  };
}

// ---------------------------------------------------------------------------
// MCP input schemas
// ---------------------------------------------------------------------------

export function buildListWorkspacesMcpInputSchema() {
  return {};
}

export function buildSetDefaultWorkspaceMcpInputSchema() {
  return {
    slug: z.string().describe("Workspace slug — must be one already configured."),
  };
}

export function buildWhoamiMcpInputSchema(workspaceDescription: string) {
  return {
    for_workspace: z
      .string()
      .optional()
      .describe(
        "Auth slug whose cached viewer to return. Defaults to the current default workspace. Renamed from `slug` for clarity vs. the standard `workspace` param.",
      ),
    workspace: z.string().optional().describe(workspaceDescription),
  };
}

export function buildRefreshWhoamiMcpInputSchema(workspaceDescription: string) {
  return {
    for_workspace: z
      .string()
      .optional()
      .describe("Auth slug to refresh. Defaults to the current default workspace."),
    workspace: z.string().optional().describe(workspaceDescription),
  };
}

export function buildSetWorkspaceDefaultTeamMcpInputSchema() {
  return {
    workspace_slug: z.string().describe("Workspace slug to set the default team for."),
    team: z.string().describe("Team key (e.g. 'NOX')."),
  };
}

// ---------------------------------------------------------------------------
// Descriptions (byte-faithful to MCP tool config)
// ---------------------------------------------------------------------------

const listWorkspacesDescription =
  "Returns ALL workspaces stored in ~/.lebop/auth.json (slug, name, viewer email, default flag). This tool is meta — it lists every workspace lebop knows about and intentionally does NOT accept a `workspace` filter param (unlike every other tool). To inspect a single workspace's viewer / cached profile, call `whoami` with `for_workspace=<slug>` instead.";

const setDefaultWorkspaceDescription = "Updates ~/.lebop/auth.json's `default` field.";

const whoamiDescription =
  "Returns the cached viewer for `for_workspace` (which auth slug to read) or the current default without network I/O. Use refresh_whoami to re-validate and persist updated auth metadata. Two distinct args: `for_workspace` chooses *which auth slug to read*; `workspace` is the universal API-target selector that sets LEBOP_WORKSPACE for this call. Usually they match; the split lets you query one slug while authenticated against another.";

const refreshWhoamiDescription =
  "Re-validates the stored token for `for_workspace` against Linear, persists the refreshed viewer/workspace metadata to the auth file, and returns the updated viewer. Use whoami for a read-only cached lookup.";

const setWorkspaceDefaultTeamDescription =
  "Updates `workspace_team_defaults[<slug>]` in ~/.lebop/config.yaml. Pairs with set_default_workspace. Idempotent at the value level.";

const authLoginDescription =
  "Add or replace a Linear personal API key (PAK) for a workspace (CLI credential setup).";

const authLogoutDescription =
  "Remove credentials for one workspace, or all if only one is configured (CLI credential teardown).";

const authTokenDescription =
  "Print a masked preview of the API token for a workspace; `--unsafe` prints the full token for piping.";

// ---------------------------------------------------------------------------
// Operation contracts
// ---------------------------------------------------------------------------

export const authLoginOperation = {
  id: "auth.login",
  domain: "auth",
  resource: "credential",
  action: "other",
  title: "Authenticate a Linear workspace (login)",
  description: authLoginDescription,
  cli: {
    command: "auth login",
    liveSteps: ["cli:auth login --token-file"],
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  exception: {
    kind: "cli_only",
    reason: "CLI-only credential setup",
  },
  notes: "Interactive/token-file/from-schpet acquisition stays in the CLI adapter.",
  fromCli: buildAuthLoginInputFromCli,
  execute: executeAuthLogin,
} satisfies SurfaceOperationContract<AuthLoginInput, AuthLoginResult, AuthLoginCliInput, never>;

export const authLogoutOperation = {
  id: "auth.logout",
  domain: "auth",
  resource: "credential",
  action: "delete",
  title: "Remove Linear workspace credentials (logout)",
  description: authLogoutDescription,
  cli: {
    command: "auth logout",
    nonLiveReason:
      "Credential teardown is exercised as cleanup after coverage validation; requiring it as an in-band live step would invalidate the remaining authenticated surface.",
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: false,
  },
  exception: {
    kind: "cli_only",
    reason: "CLI-only credential teardown",
  },
  fromCli: buildAuthLogoutInputFromCli,
  execute: executeAuthLogout,
} satisfies SurfaceOperationContract<AuthLogoutInput, AuthLogoutResult, AuthLogoutCliInput, never>;

export const listWorkspacesOperation = {
  id: "auth.list_workspaces",
  domain: "auth",
  resource: "workspace",
  action: "list",
  title: "List configured Linear workspaces",
  description: listWorkspacesDescription,
  cli: {
    command: "auth list",
    liveSteps: ["cli:auth list --json"],
  },
  mcp: {
    tool: "list_workspaces",
    title: "List configured Linear workspaces",
    description: listWorkspacesDescription,
    annotations: {
      title: "List configured Linear workspaces",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: [],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildListWorkspacesInputFromCli,
  fromMcp: buildListWorkspacesInputFromMcp,
  execute: executeListWorkspaces,
} satisfies SurfaceOperationContract<
  ListWorkspacesInput,
  ListWorkspacesResult,
  ListWorkspacesCliInput,
  ListWorkspacesMcpInput
>;

/** Inventory alias: `auth default` read mode maps to list_workspaces.default. */
export const listWorkspacesDefaultReadOperation = {
  id: "auth.list_workspaces.default_read",
  domain: "auth",
  resource: "workspace",
  action: "get",
  aliasOf: "auth.list_workspaces",
  title: "List configured Linear workspaces",
  description: listWorkspacesDescription,
  cli: {
    command: "auth default",
    liveSteps: ["cli:auth default"],
  },
  mcp: {
    tool: "list_workspaces",
    title: "List configured Linear workspaces",
    description: listWorkspacesDescription,
    annotations: {
      title: "List configured Linear workspaces",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: [],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes:
    "No-arg `auth default` read mode maps to list_workspaces.default; setter mode is auth.set_default_workspace.",
  fromCli: buildListWorkspacesInputFromCli,
  fromMcp: buildListWorkspacesInputFromMcp,
  execute: executeListWorkspaces,
} satisfies SurfaceOperationContract<
  ListWorkspacesInput,
  ListWorkspacesResult,
  ListWorkspacesCliInput,
  ListWorkspacesMcpInput
>;

export const setDefaultWorkspaceOperation = {
  id: "auth.set_default_workspace",
  domain: "auth",
  resource: "workspace",
  action: "update",
  title: "Set the default workspace for tool calls without an explicit workspace arg",
  description: setDefaultWorkspaceDescription,
  cli: {
    command: "auth default",
    liveSteps: ["cli:auth default"],
  },
  mcp: {
    tool: "set_default_workspace",
    title: "Set the default workspace for tool calls without an explicit workspace arg",
    description: setDefaultWorkspaceDescription,
    annotations: {
      title: "Set the default workspace for tool calls without an explicit workspace arg",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchemaKeys: ["slug"],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
  notes: "Setter mode only; auth default read mode maps to list_workspaces.default.",
  fromCli: buildSetDefaultWorkspaceInputFromCli,
  fromMcp: buildSetDefaultWorkspaceInputFromMcp,
  execute: executeSetDefaultWorkspace,
} satisfies SurfaceOperationContract<
  SetDefaultWorkspaceInput,
  SetDefaultWorkspaceResult,
  SetDefaultWorkspaceCliInput,
  SetDefaultWorkspaceMcpInput
>;

export const authTokenOperation = {
  id: "auth.token",
  domain: "auth",
  resource: "credential",
  action: "get",
  title: "Print API token (masked or full)",
  description: authTokenDescription,
  cli: {
    command: "auth token",
    liveSteps: ["cli:auth token masked"],
  },
  safety: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  exception: {
    kind: "cli_only",
    reason: "secret-printing CLI escape hatch",
  },
  fromCli: buildAuthTokenInputFromCli,
  execute: executeAuthToken,
} satisfies SurfaceOperationContract<AuthTokenInput, AuthTokenResult, AuthTokenCliInput, never>;

export const whoamiOperation = {
  id: "auth.whoami",
  domain: "auth",
  resource: "viewer",
  action: "get",
  title: "Current viewer for a workspace",
  description: whoamiDescription,
  cli: {
    command: "auth whoami",
    liveSteps: ["cli:auth whoami --json", "cli:auth whoami --refresh --json"],
  },
  mcp: {
    tool: "whoami",
    title: "Current viewer for a workspace",
    description: whoamiDescription,
    annotations: {
      title: "Current viewer for a workspace",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["for_workspace", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildWhoamiInputFromCli,
  fromMcp: buildWhoamiInputFromMcp,
  execute: executeWhoami,
} satisfies SurfaceOperationContract<WhoamiInput, WhoamiResult, WhoamiCliInput, WhoamiMcpInput>;

export const refreshWhoamiOperation = {
  id: "auth.refresh_whoami",
  domain: "auth",
  resource: "viewer",
  action: "update",
  title: "Refresh cached viewer for a workspace",
  description: refreshWhoamiDescription,
  cli: {
    command: "auth whoami",
    liveSteps: ["cli:auth whoami --refresh --json"],
  },
  mcp: {
    tool: "refresh_whoami",
    title: "Refresh cached viewer for a workspace",
    description: refreshWhoamiDescription,
    annotations: {
      title: "Refresh cached viewer for a workspace",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["for_workspace", "workspace"],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  notes:
    "Refresh mode for `lebop auth whoami --refresh`; writes refreshed auth metadata. CLI vs MCP response metadata source differs (behavior freeze).",
  fromCli: buildRefreshWhoamiInputFromCli,
  fromMcp: buildRefreshWhoamiInputFromMcp,
  execute: executeRefreshWhoami,
} satisfies SurfaceOperationContract<
  RefreshWhoamiInput,
  WhoamiResult,
  RefreshWhoamiCliInput,
  RefreshWhoamiMcpInput
>;

export const setWorkspaceDefaultTeamOperation = {
  id: "auth.set_workspace_default_team",
  domain: "auth",
  resource: "config",
  action: "update",
  title: "Set the default team for a workspace",
  description: setWorkspaceDefaultTeamDescription,
  cli: {
    command: "auth set-default-team",
    liveSteps: ["cli:auth set-default-team --json"],
  },
  mcp: {
    tool: "set_workspace_default_team",
    title: "Set the default team for a workspace",
    description: setWorkspaceDefaultTeamDescription,
    annotations: {
      title: "Set the default team for a workspace",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchemaKeys: ["workspace_slug", "team"],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
  notes:
    "CLI persists resolved team key; MCP persists caller-provided team string (behavior freeze). Not-found hints stay adapter-specific.",
  fromCli: buildSetWorkspaceDefaultTeamInputFromCli,
  fromMcp: buildSetWorkspaceDefaultTeamInputFromMcp,
} satisfies SurfaceOperationContract<
  SetWorkspaceDefaultTeamInput,
  SetWorkspaceDefaultTeamResult,
  SetWorkspaceDefaultTeamCliInput,
  SetWorkspaceDefaultTeamMcpInput
>;

export const AUTH_SURFACE_OPERATIONS = [
  authLoginOperation,
  authLogoutOperation,
  listWorkspacesOperation,
  listWorkspacesDefaultReadOperation,
  setDefaultWorkspaceOperation,
  authTokenOperation,
  whoamiOperation,
  refreshWhoamiOperation,
  setWorkspaceDefaultTeamOperation,
] as const;
