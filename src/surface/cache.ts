import { z } from "zod";
import { type GcResult, gcCache } from "../lib/cache.ts";
import {
  applyCachePushPlans,
  type CachePushResult,
  type CachePushSummary,
  collectCachePushPlans,
} from "../lib/cachePush.ts";
import { type CacheStatusResult, collectCacheStatus } from "../lib/cacheStatus.ts";
import { parseCliNumber } from "../lib/cliOptions.ts";
import { resolveConfig } from "../lib/config.ts";
import {
  diffIssueCacheVsRemote,
  diffProjectCacheVsRemote,
  type FieldDiff,
  type IssueCacheRemoteDiff,
  type ProjectCacheRemoteDiff,
} from "../lib/diff.ts";
import { ValidationError } from "../lib/errors.ts";
import { expandIds } from "../lib/expand.ts";
import { deriveTeamFromIdentifiers } from "../lib/resolve.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, repoRootArg, teamArg, workspaceArg } from "./schema.ts";

// ---------------------------------------------------------------------------
// Canonical inputs / results — status
// ---------------------------------------------------------------------------

export interface CacheStatusInput {
  team?: string;
  repoRoot?: string;
  checkRemote?: boolean;
  requireGitRoot?: boolean;
}

export interface CacheStatusCliInput {
  opts: {
    team?: string;
    remote?: boolean;
  };
}

export type CacheStatusMcpInput = Record<string, unknown> & {
  repo_root?: string;
  team?: string;
  check_remote?: boolean;
  workspace?: string;
};

export interface CacheStatusExecutionResult {
  config: {
    team: string;
    repoRoot: string | null;
    repoHash: string;
  };
  status: CacheStatusResult;
}

// ---------------------------------------------------------------------------
// Canonical inputs / results — gc
// ---------------------------------------------------------------------------

export interface CacheGcInput {
  maxAgeDays?: number;
  maxSizeMb?: number;
  hash?: string;
  dryRun: boolean;
  preserveCwdRepo: boolean;
}

export interface CacheGcCliInput {
  opts: {
    maxAge?: string;
    maxSize?: string;
    hash?: string;
    dryRun?: boolean;
    preserveCwd?: boolean;
    yes?: boolean;
  };
}

export type CacheGcMcpInput = Record<string, unknown> & {
  max_age_days?: number;
  max_size_mb?: number;
  hash?: string;
  dry_run?: boolean;
  confirm?: boolean;
  preserve_cwd_repo?: boolean;
};

export interface CacheGcExecutionResult {
  dryRun: boolean;
  result: GcResult;
}

// ---------------------------------------------------------------------------
// Canonical inputs / results — diff
// ---------------------------------------------------------------------------

export interface CacheDiffIssueInput {
  identifier: string;
  team?: string;
  repoRoot?: string;
}

export interface CacheDiffProjectInput {
  projectId: string;
  team?: string;
  repoRoot?: string;
}

export interface CacheDiffCliInput {
  id?: string;
  opts: {
    team?: string;
    projectId?: string;
  };
}

export type CacheDiffIssueMcpInput = Record<string, unknown> & {
  identifier: string;
  repo_root?: string;
  team?: string;
  workspace?: string;
};

export type CacheDiffProjectMcpInput = Record<string, unknown> & {
  project_id: string;
  repo_root?: string;
  team?: string;
  workspace?: string;
};

export type CacheDiffIssueExecutionResult = IssueCacheRemoteDiff;
export type CacheDiffProjectExecutionResult = ProjectCacheRemoteDiff;

// ---------------------------------------------------------------------------
// Canonical inputs / results — push
// ---------------------------------------------------------------------------

export interface CachePushInput {
  identifiers?: string[];
  projectIds?: string[];
  team?: string;
  repoRoot?: string;
  dryRun?: boolean;
  force?: boolean;
  strict?: boolean;
  requireGitRoot?: boolean;
  deriveTeamFromIdentifiers?: boolean;
}

export interface CachePushCliInput {
  ids: string[];
  opts: {
    team?: string;
    dryRun?: boolean;
    force?: boolean;
    yes?: boolean;
    confirm?: boolean;
    strict?: boolean;
    projectId?: string[];
  };
}

export type CachePushMcpInput = Record<string, unknown> & {
  identifiers?: string[];
  project_ids?: string[];
  repo_root?: string;
  team?: string;
  dry_run?: boolean;
  force?: boolean;
  confirm?: boolean;
  strict?: boolean;
  workspace?: string;
};

export interface CachePushExecutionResult {
  team: string;
  repoHash: string;
  dryRun: boolean;
  results: CachePushResult[];
  summary: CachePushSummary;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const cacheStatusCanonicalSchema = z
  .object({
    team: teamArg,
    repoRoot: repoRootArg,
    checkRemote: z.boolean().optional(),
    requireGitRoot: z.boolean().optional(),
  })
  .strict();

const cacheGcCanonicalSchema = z
  .object({
    maxAgeDays: z.number().min(0).optional(),
    maxSizeMb: z.number().min(0).optional(),
    hash: z.string().optional(),
    dryRun: z.boolean(),
    preserveCwdRepo: z.boolean(),
  })
  .strict();

const cacheDiffIssueCanonicalSchema = z
  .object({
    identifier: z.string().min(1),
    team: teamArg,
    repoRoot: repoRootArg,
  })
  .strict();

const cacheDiffProjectCanonicalSchema = z
  .object({
    projectId: z.string().min(1),
    team: teamArg,
    repoRoot: repoRootArg,
  })
  .strict();

const cachePushCanonicalSchema = z
  .object({
    identifiers: z.array(z.string()).optional(),
    projectIds: z.array(z.string()).optional(),
    team: teamArg,
    repoRoot: repoRootArg,
    dryRun: z.boolean().optional(),
    force: z.boolean().optional(),
    strict: z.boolean().optional(),
    requireGitRoot: z.boolean().optional(),
    deriveTeamFromIdentifiers: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Input builders — status
// ---------------------------------------------------------------------------

export function buildCacheStatusInputFromCli(input: CacheStatusCliInput): CacheStatusInput {
  return parseSurfaceInput("cache.status", cacheStatusCanonicalSchema, {
    team: input.opts.team,
    checkRemote: input.opts.remote !== false,
  });
}

export function buildCacheStatusInputFromMcp(input: CacheStatusMcpInput): CacheStatusInput {
  return parseSurfaceInput("cache.status", cacheStatusCanonicalSchema, {
    team: input.team,
    repoRoot: input.repo_root,
    checkRemote: input.check_remote !== false,
    requireGitRoot: Boolean(input.repo_root),
  });
}

// ---------------------------------------------------------------------------
// Input builders — gc
// ---------------------------------------------------------------------------

function parsePositiveGcNumber(label: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return parseCliNumber(raw, { optionName: label });
}

export function buildCacheGcInputFromCli(input: CacheGcCliInput): CacheGcInput {
  // Parse numerics before the confirm gate so malformed flags surface first
  // (behavior freeze vs legacy CLI order).
  const maxAgeDays = parsePositiveGcNumber("--max-age", input.opts.maxAge);
  const maxSizeMb = parsePositiveGcNumber("--max-size", input.opts.maxSize);
  const dryRun = input.opts.dryRun !== false; // default true; --no-dry-run flips to false
  const preserveCwdRepo = input.opts.preserveCwd !== false; // default true
  if (!dryRun && input.opts.yes !== true) {
    throw new ValidationError(
      "cache gc deletion requires --yes",
      "run without --no-dry-run to preview, or pass --no-dry-run --yes to confirm deletion",
    );
  }
  return parseSurfaceInput("cache.gc", cacheGcCanonicalSchema, {
    maxAgeDays,
    maxSizeMb,
    hash: input.opts.hash,
    dryRun,
    preserveCwdRepo,
  });
}

export function buildCacheGcInputFromMcp(input: CacheGcMcpInput): CacheGcInput {
  const dryRun = input.dry_run === undefined ? true : input.dry_run;
  return parseSurfaceInput("cache.gc", cacheGcCanonicalSchema, {
    maxAgeDays: input.max_age_days,
    maxSizeMb: input.max_size_mb,
    hash: input.hash,
    dryRun,
    preserveCwdRepo: input.preserve_cwd_repo === undefined ? true : input.preserve_cwd_repo,
  });
}

// ---------------------------------------------------------------------------
// Input builders — diff
// ---------------------------------------------------------------------------

export function buildCacheDiffIssueInputFromCli(input: CacheDiffCliInput): CacheDiffIssueInput {
  if (!input.id) {
    throw new ValidationError(
      "missing issue id; pass an issue id or --project-id <uuid>",
      "pass an issue identifier or --project-id <uuid>",
    );
  }
  return parseSurfaceInput("cache.diff_issue", cacheDiffIssueCanonicalSchema, {
    identifier: input.id,
    team: input.opts.team,
  });
}

export function buildCacheDiffProjectInputFromCli(input: CacheDiffCliInput): CacheDiffProjectInput {
  if (!input.opts.projectId) {
    throw new ValidationError(
      "missing issue id; pass an issue id or --project-id <uuid>",
      "pass an issue identifier or --project-id <uuid>",
    );
  }
  if (input.id) {
    throw new ValidationError(
      "pass either an issue id or --project-id, not both",
      "choose one diff target",
    );
  }
  return parseSurfaceInput("cache.diff_project", cacheDiffProjectCanonicalSchema, {
    projectId: input.opts.projectId,
    team: input.opts.team,
  });
}

export function buildCacheDiffIssueInputFromMcp(
  input: CacheDiffIssueMcpInput,
): CacheDiffIssueInput {
  return parseSurfaceInput("cache.diff_issue", cacheDiffIssueCanonicalSchema, {
    identifier: input.identifier,
    team: input.team,
    repoRoot: input.repo_root,
  });
}

export function buildCacheDiffProjectInputFromMcp(
  input: CacheDiffProjectMcpInput,
): CacheDiffProjectInput {
  return parseSurfaceInput("cache.diff_project", cacheDiffProjectCanonicalSchema, {
    projectId: input.project_id,
    team: input.team,
    repoRoot: input.repo_root,
  });
}

// ---------------------------------------------------------------------------
// Input builders — push
// ---------------------------------------------------------------------------

export function buildCachePushInputFromCli(input: CachePushCliInput): CachePushInput {
  const dryRun = input.opts.dryRun === true;
  if (input.opts.force === true && !dryRun && !isPushConfirmed(input.opts)) {
    throw new ValidationError(
      "refusing to push with --force without --yes/--confirm",
      "run with --dry-run to preview, or pass --yes/--confirm after verifying stale-guard bypass is intended",
    );
  }
  return parseSurfaceInput("cache.push", cachePushCanonicalSchema, {
    identifiers: expandIds(input.ids),
    projectIds: input.opts.projectId ?? [],
    team: input.opts.team,
    dryRun,
    force: input.opts.force === true,
    strict: input.opts.strict === true,
  });
}

export function buildCachePushInputFromMcp(input: CachePushMcpInput): CachePushInput {
  return parseSurfaceInput("cache.push", cachePushCanonicalSchema, {
    identifiers: input.identifiers,
    projectIds: input.project_ids,
    team: input.team,
    repoRoot: input.repo_root,
    dryRun: input.dry_run === true,
    force: input.force === true,
    strict: input.strict === true,
    requireGitRoot: Boolean(input.repo_root),
    deriveTeamFromIdentifiers: true,
  });
}

function isPushConfirmed(opts: { yes?: boolean; confirm?: boolean }): boolean {
  return opts.yes === true || opts.confirm === true;
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function executeCacheStatus(
  input: CacheStatusInput,
): Promise<CacheStatusExecutionResult> {
  const config = await resolveConfig({
    cwd: input.repoRoot,
    teamOverride: input.team,
    requireGitRoot: input.requireGitRoot === true,
  });
  const status = await collectCacheStatus({
    team: config.team,
    repoRoot: config.repoRoot,
    repoHash: config.repoHash,
    checkRemote: input.checkRemote !== false,
  });
  return {
    config: {
      team: config.team,
      repoRoot: config.repoRoot,
      repoHash: config.repoHash,
    },
    status,
  };
}

export function cacheStatusPayload(result: CacheStatusExecutionResult): CacheStatusResult {
  return result.status;
}

export async function executeCacheGc(input: CacheGcInput): Promise<CacheGcExecutionResult> {
  const result = await gcCache({
    maxAgeDays: input.maxAgeDays,
    maxSizeMb: input.maxSizeMb,
    hash: input.hash,
    dryRun: input.dryRun,
    preserveCwdRepo: input.preserveCwdRepo,
  });
  return { dryRun: input.dryRun, result };
}

export function cacheGcPayload(result: CacheGcExecutionResult) {
  return { dry_run: result.dryRun, ...result.result };
}

export async function executeCacheDiffIssue(
  input: CacheDiffIssueInput,
): Promise<CacheDiffIssueExecutionResult> {
  return diffIssueCacheVsRemote(input.identifier, {
    repoRoot: input.repoRoot,
    team: input.team,
  });
}

export async function executeCacheDiffProject(
  input: CacheDiffProjectInput,
): Promise<CacheDiffProjectExecutionResult> {
  return diffProjectCacheVsRemote(input.projectId, {
    repoRoot: input.repoRoot,
    team: input.team,
  });
}

export async function executeCachePush(input: CachePushInput): Promise<CachePushExecutionResult> {
  const requested = input.identifiers;
  const requestedProjects = input.projectIds;
  const teamOverride =
    input.team ??
    (input.deriveTeamFromIdentifiers && requested && requested.length > 0
      ? (deriveTeamFromIdentifiers(requested) ?? undefined)
      : undefined);
  const config = await resolveConfig({
    cwd: input.repoRoot,
    teamOverride,
    requireGitRoot: input.requireGitRoot === true,
  });
  const dryRun = input.dryRun === true;
  const force = input.force === true;
  const strict = input.strict === true;
  const lintCtx = {
    repoConfig: config.repoConfig,
    workspaceUrlPrefix: config.workspaceUrlPrefix,
  };
  const plans = await collectCachePushPlans(config.repoHash, {
    identifiers: requested,
    projectIds: requestedProjects,
    includeUnchanged: Boolean(requested?.length || requestedProjects?.length),
  });
  const { results, summary } = await applyCachePushPlans({
    repoHash: config.repoHash,
    team: config.team,
    plans,
    lintCtx,
    dryRun,
    force,
    strict,
  });
  return {
    team: config.team,
    repoHash: config.repoHash,
    dryRun,
    results,
    summary,
  };
}

export function cachePushPayload(result: CachePushExecutionResult) {
  return {
    team: result.team,
    repo_hash: result.repoHash,
    mode: "cache" as const,
    results: result.results,
    summary: result.summary,
    notes: result.dryRun ? "dry-run: nothing was written" : undefined,
  };
}

// ---------------------------------------------------------------------------
// MCP input schemas
// ---------------------------------------------------------------------------

export function buildCacheStatusMcpInputSchema(workspaceDescription: string) {
  return {
    repo_root: z
      .string()
      .optional()
      .describe(
        "Override the cwd-derived repo root. When omitted, uses the MCP server's cwd → git root.",
      ),
    team: z.string().optional(),
    check_remote: z
      .boolean()
      .optional()
      .describe("Run the remote-staleness check. Defaults to true."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCacheDiffIssueMcpInputSchema(workspaceDescription: string) {
  return {
    identifier: z.string(),
    repo_root: z.string().optional(),
    team: z.string().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCacheDiffProjectMcpInputSchema(workspaceDescription: string) {
  return {
    project_id: z.string().describe("Project UUID cached by pull_project."),
    repo_root: z.string().optional(),
    team: z.string().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCachePushMcpInputSchema(workspaceDescription: string) {
  return {
    identifiers: z
      .array(z.string())
      .optional()
      .describe("Restrict to these identifiers; defaults to every modified cached issue."),
    project_ids: z
      .array(z.string())
      .optional()
      .describe(
        "Restrict project cache pushes to these project UUIDs. Defaults to modified cached projects when identifiers is omitted.",
      ),
    repo_root: z.string().optional(),
    team: z.string().optional(),
    dry_run: z.boolean().optional(),
    force: z.boolean().optional().describe("Bypass the updatedAt stale guard."),
    confirm: z
      .boolean()
      .optional()
      .describe("Required true when force=true because stale protection is bypassed."),
    strict: z.boolean().optional().describe("Block pushes with lint warnings."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCacheGcMcpInputSchema() {
  return {
    max_age_days: z
      .number()
      .min(0)
      .optional()
      .describe("Evict repos whose newest file is older than N days (default 30)."),
    max_size_mb: z
      .number()
      .min(0)
      .optional()
      .describe("Trim oldest repos until total cache size is below the limit (default 500)."),
    hash: z.string().optional().describe("Evict only the named hash; bypasses age/size selection."),
    dry_run: z
      .boolean()
      .optional()
      .describe("Report candidates without removing. Defaults to true."),
    confirm: z
      .boolean()
      .optional()
      .describe("Required true when dry_run:false will remove local cache directories."),
    preserve_cwd_repo: z
      .boolean()
      .optional()
      .describe("Skip the cwd's repo cache even if it qualifies. Defaults to true."),
  };
}

// ---------------------------------------------------------------------------
// Operation contracts
// ---------------------------------------------------------------------------

const cacheStatusDescription =
  "Returns modified / clean / stale entries in the cache. `stale` means the remote `updatedAt` is newer than the local `_server.updated_at` snapshot — call pull_issues or pull_project with refresh=true and confirm=true to update after verifying local cache overwrite is intended.";

const cacheStatusTitle = "git-like status for the local lebop cache";

export const cacheStatusOperation = {
  id: "cache.status",
  domain: "cache",
  resource: "cache",
  action: "get",
  title: cacheStatusTitle,
  description: cacheStatusDescription,
  cli: {
    command: "status",
    liveSteps: ["cli:status --json"],
  },
  mcp: {
    tool: "cache_status",
    title: cacheStatusTitle,
    description: cacheStatusDescription,
    annotations: {
      title: cacheStatusTitle,
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["repo_root", "team", "check_remote", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildCacheStatusInputFromCli,
  fromMcp: buildCacheStatusInputFromMcp,
  execute: executeCacheStatus,
} satisfies SurfaceOperationContract<
  CacheStatusInput,
  CacheStatusExecutionResult,
  CacheStatusCliInput,
  CacheStatusMcpInput
>;

export const cacheStatusAliasOperation = {
  id: "cache.status.alias",
  domain: "cache",
  resource: "cache",
  action: "get",
  aliasOf: "cache.status",
  title: cacheStatusTitle,
  description: "CLI alias under `cache status` for discoverability parity with MCP `cache_status`.",
  cli: {
    command: "cache status",
    liveSteps: ["cli:cache status --json"],
  },
  mcp: {
    tool: "cache_status",
    title: cacheStatusTitle,
    description: cacheStatusDescription,
    annotations: {
      title: cacheStatusTitle,
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["repo_root", "team", "check_remote", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildCacheStatusInputFromCli,
  fromMcp: buildCacheStatusInputFromMcp,
  execute: executeCacheStatus,
} satisfies SurfaceOperationContract<
  CacheStatusInput,
  CacheStatusExecutionResult,
  CacheStatusCliInput,
  CacheStatusMcpInput
>;

const cacheDiffIssueTitle = "unified diff: local cache vs live remote (one issue)";
const cacheDiffIssueDescription =
  "Field-level diff + description unified-patch for a single cached issue. Returns null patch if no description drift.";

export const cacheDiffIssueOperation = {
  id: "cache.diff_issue",
  domain: "cache",
  resource: "issue",
  action: "get",
  title: cacheDiffIssueTitle,
  description: cacheDiffIssueDescription,
  cli: {
    command: "diff",
    liveSteps: ["cli:diff issue --json"],
  },
  mcp: {
    tool: "diff_issue",
    title: cacheDiffIssueTitle,
    description: cacheDiffIssueDescription,
    annotations: {
      title: cacheDiffIssueTitle,
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["identifier", "repo_root", "team", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildCacheDiffIssueInputFromCli,
  fromMcp: buildCacheDiffIssueInputFromMcp,
  execute: executeCacheDiffIssue,
} satisfies SurfaceOperationContract<
  CacheDiffIssueInput,
  CacheDiffIssueExecutionResult,
  CacheDiffCliInput,
  CacheDiffIssueMcpInput
>;

const cacheDiffProjectTitle = "unified diff: local cache vs live remote (one project)";
const cacheDiffProjectDescription =
  "Field-level diff + content unified-patch for a single cached project. Returns null patch if no content drift.";

export const cacheDiffProjectOperation = {
  id: "cache.diff_project",
  domain: "cache",
  resource: "project",
  action: "get",
  title: cacheDiffProjectTitle,
  description: cacheDiffProjectDescription,
  cli: {
    command: "diff",
  },
  mcp: {
    tool: "diff_project",
    title: cacheDiffProjectTitle,
    description: cacheDiffProjectDescription,
    annotations: {
      title: cacheDiffProjectTitle,
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["project_id", "repo_root", "team", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes:
    "CLI routes issue vs project via optional id vs --project-id on the shared `diff` command.",
  fromCli: buildCacheDiffProjectInputFromCli,
  fromMcp: buildCacheDiffProjectInputFromMcp,
  execute: executeCacheDiffProject,
} satisfies SurfaceOperationContract<
  CacheDiffProjectInput,
  CacheDiffProjectExecutionResult,
  CacheDiffCliInput,
  CacheDiffProjectMcpInput
>;

const cachePushTitle = "Push locally-modified cache entries back to Linear (stale-guarded)";
const cachePushDescription =
  "Reads the local cache, computes per-issue/project field diffs, and applies updates as Linear mutations. Uses the cached _server.updated_at snapshot plus a just-in-time remote recheck as a stale guard; pass force=true to bypass. dry_run=true previews without writing.";

export const cachePushOperation = {
  id: "cache.push",
  domain: "cache",
  resource: "cache",
  action: "update",
  title: cachePushTitle,
  description: cachePushDescription,
  cli: {
    command: "push",
    liveSteps: ["cli:push issue --json"],
  },
  mcp: {
    tool: "push_changes",
    title: cachePushTitle,
    description: cachePushDescription,
    annotations: {
      title: cachePushTitle,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: [
      "identifiers",
      "project_ids",
      "repo_root",
      "team",
      "dry_run",
      "force",
      "confirm",
      "strict",
      "workspace",
    ],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  notes:
    "Confirm required when force=true and not dry-run. CLI expands identifier ranges; MCP does not. MCP may derive team from identifiers when team is omitted.",
  fromCli: buildCachePushInputFromCli,
  fromMcp: buildCachePushInputFromMcp,
  execute: executeCachePush,
} satisfies SurfaceOperationContract<
  CachePushInput,
  CachePushExecutionResult,
  CachePushCliInput,
  CachePushMcpInput
>;

const cacheGcTitle = "Garbage-collect stale per-repo cache directories";
const cacheGcDescription =
  "Scan ~/.lebop/cache/ for per-repo subdirs and report (or remove) stale ones. Defaults to dry-run + preserving the cwd's repo cache. Mirrors `lebop cache gc`.";

export const cacheGcOperation = {
  id: "cache.gc",
  domain: "cache",
  resource: "cache",
  action: "delete",
  title: cacheGcTitle,
  description: cacheGcDescription,
  cli: {
    command: "cache gc",
    liveSteps: ["cli:cache gc dry-run --json"],
  },
  mcp: {
    tool: "cache_gc",
    title: cacheGcTitle,
    description: cacheGcDescription,
    annotations: {
      title: cacheGcTitle,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchemaKeys: [
      "max_age_days",
      "max_size_mb",
      "hash",
      "dry_run",
      "confirm",
      "preserve_cwd_repo",
    ],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    confirm: "required_when_mutating",
  },
  notes:
    "Local-filesystem only (openWorld: false). Defaults dry_run=true; confirm required when dry_run=false. CLI uses --no-dry-run/--yes; MCP uses dry_run/confirm.",
  fromCli: buildCacheGcInputFromCli,
  fromMcp: buildCacheGcInputFromMcp,
  execute: executeCacheGc,
} satisfies SurfaceOperationContract<
  CacheGcInput,
  CacheGcExecutionResult,
  CacheGcCliInput,
  CacheGcMcpInput
>;

export const CACHE_SURFACE_OPERATIONS = [
  cacheStatusOperation,
  cacheStatusAliasOperation,
  cacheDiffIssueOperation,
  cacheDiffProjectOperation,
  cachePushOperation,
  cacheGcOperation,
] as const;

// Re-export FieldDiff for CLI human printers that stay presentation-only.
export type { FieldDiff };
