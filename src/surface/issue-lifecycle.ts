import { z } from "zod";
import type { BulkUpdateInput, BulkUpdatePatch, BulkUpdateResult } from "../lib/bulk.ts";
import { bulkUpdateIssues } from "../lib/bulk.ts";
import {
  type IssueCacheNotRefreshedSummary,
  issueCacheNotRefreshed,
  summarizeIssueCacheRefresh,
} from "../lib/cacheCoherence.ts";
import {
  type IssueCacheRefreshResult,
  refreshCachedIssueByIdentifier,
} from "../lib/cacheRefresh.ts";
import { parseCliNumber } from "../lib/cliOptions.ts";
import { ValidationError } from "../lib/errors.ts";
import { expandIds } from "../lib/expand.ts";
import {
  archiveIssues,
  type FetchedIssue,
  type LifecycleResult,
  unarchiveIssues,
} from "../lib/issues.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import type { IssueRepoCacheContext, IssueRepoCacheDeps } from "./issue-write.ts";
import { parseSurfaceInput, repoRootArg, teamArg, workspaceArg } from "./schema.ts";

export interface IssueLifecycleInput {
  identifiers: string[];
  repoRoot?: string;
  /** True when CLI --yes or MCP confirm:true was provided (archive destructive gate). */
  confirmed?: boolean;
}

export interface IssueArchiveCliInput {
  identifiers: string[];
  opts: { yes?: boolean };
}

export type IssueLifecycleMcpInput = Record<string, unknown> & {
  identifiers: string[];
  repo_root?: string;
  confirm?: boolean;
};

export interface IssueArchiveExecutionResult {
  results: LifecycleResult[];
  cache: IssueCacheNotRefreshedSummary;
}

export interface IssueUnarchiveExecutionResult {
  results: LifecycleResult[];
  cache: ReturnType<typeof summarizeIssueCacheRefresh>;
}

export interface IssueBulkUpdateInput extends BulkUpdateInput {}

export interface IssueBulkUpdateCliInput {
  identifiers: string[];
  opts: {
    state?: string;
    priority?: string;
    label?: string[];
    assignee?: string;
    estimate?: string;
    project?: string;
    milestone?: string;
    cycle?: string;
    team?: string;
    dryRun?: boolean;
    yes?: boolean;
    confirm?: boolean;
  };
  repoHash?: string;
  repoRoot?: string | null;
}

export type IssueBulkUpdateMcpInput = Record<string, unknown> & {
  identifiers: string[];
  patch: BulkUpdatePatch;
  team?: string;
  dry_run?: boolean;
  confirm?: boolean;
  repo_root?: string;
};

const issueLifecycleCanonicalSchema: z.ZodType<IssueLifecycleInput> = z
  .object({
    identifiers: z.array(z.string()),
    repoRoot: repoRootArg,
    confirmed: z.boolean().optional(),
  })
  .strict();

const issueBulkUpdateCanonicalSchema = z
  .object({
    identifiers: z.array(z.string()),
    patch: z.object({
      state: z.string().optional(),
      priority: z.union([z.string(), z.number()]).optional(),
      labels: z.array(z.string()).optional(),
      assignee: z.string().nullable().optional(),
      estimate: z.number().nullable().optional(),
      project: z.string().nullable().optional(),
      milestone: z.string().nullable().optional(),
      cycle: z.string().nullable().optional(),
    }),
    team: teamArg,
    dryRun: z.boolean().optional(),
    confirmed: z.boolean().optional(),
    repoHash: z.string().optional(),
    repoRoot: z.string().nullable().optional(),
  })
  .strict();

export function buildIssueArchiveInputFromCli(input: IssueArchiveCliInput): IssueLifecycleInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      "refusing to archive issues without --yes",
      "re-run with --yes to confirm this destructive state change",
    );
  }
  return validateIssueLifecycleInput(
    parseSurfaceInput("issues.archive", issueLifecycleCanonicalSchema, {
      identifiers: expandIds(input.identifiers),
      confirmed: true,
    }),
    "archive",
  );
}

export function buildIssueArchiveInputFromMcp(input: IssueLifecycleMcpInput): IssueLifecycleInput {
  if (input.confirm !== true) {
    throw new ValidationError(
      "archive_issue requires confirm:true for destructive execution",
      "pass confirm:true after verifying the archive is intended",
    );
  }
  return validateIssueLifecycleInput(
    parseSurfaceInput("issues.archive", issueLifecycleCanonicalSchema, {
      identifiers: expandIds(input.identifiers),
      repoRoot: input.repo_root,
      confirmed: true,
    }),
    "archive_issue",
  );
}

export function buildIssueUnarchiveInputFromCli(input: {
  identifiers: string[];
}): IssueLifecycleInput {
  return validateIssueLifecycleInput(
    parseSurfaceInput("issues.unarchive", issueLifecycleCanonicalSchema, {
      identifiers: expandIds(input.identifiers),
    }),
    "unarchive",
  );
}

export function buildIssueUnarchiveInputFromMcp(
  input: IssueLifecycleMcpInput,
): IssueLifecycleInput {
  return validateIssueLifecycleInput(
    parseSurfaceInput("issues.unarchive", issueLifecycleCanonicalSchema, {
      identifiers: expandIds(input.identifiers),
      repoRoot: input.repo_root,
    }),
    "unarchive_issue",
  );
}

export function buildIssueBulkUpdateInputFromCli(
  input: IssueBulkUpdateCliInput,
): IssueBulkUpdateInput {
  const patch: BulkUpdatePatch = {};
  if (input.opts.state !== undefined) patch.state = input.opts.state;
  if (input.opts.priority !== undefined) patch.priority = input.opts.priority;
  if (input.opts.label !== undefined) patch.labels = input.opts.label;
  if (input.opts.assignee !== undefined) {
    patch.assignee = input.opts.assignee === "null" ? null : input.opts.assignee;
  }
  if (input.opts.estimate !== undefined) {
    patch.estimate =
      input.opts.estimate === "null"
        ? null
        : parseCliNumber(input.opts.estimate, {
            optionName: "--estimate",
            allowNullHint: true,
          });
  }
  if (input.opts.project !== undefined) {
    patch.project = input.opts.project === "null" ? null : input.opts.project;
  }
  if (input.opts.milestone !== undefined) {
    patch.milestone = input.opts.milestone === "null" ? null : input.opts.milestone;
  }
  if (input.opts.cycle !== undefined) {
    patch.cycle = input.opts.cycle === "null" ? null : input.opts.cycle;
  }
  if (input.opts.dryRun !== true && input.opts.yes !== true && input.opts.confirm !== true) {
    throw new ValidationError(
      "refusing to bulk update issues without --yes",
      "run with --dry-run to preview, or re-run with --yes/--confirm to apply the batch update",
    );
  }

  const confirmed = input.opts.yes === true || input.opts.confirm === true;
  return validateIssueBulkUpdateInput({
    identifiers: input.identifiers,
    patch,
    team: input.opts.team,
    ...(input.opts.dryRun === undefined ? {} : { dryRun: input.opts.dryRun }),
    ...(confirmed ? { confirmed: true } : {}),
    repoHash: input.repoHash,
    repoRoot: input.repoRoot,
  });
}

export function buildIssueBulkUpdateInputFromMcp(
  input: IssueBulkUpdateMcpInput,
  deps: IssueRepoCacheDeps,
): IssueBulkUpdateInput {
  const cacheContext = deps.resolveCacheContext(input.repo_root);
  const dryRun = input.dry_run === true;
  const confirmed = input.confirm === true;
  if (!dryRun && !confirmed) {
    throw new ValidationError(
      "bulk_update_issues requires confirm:true when dry_run is not true",
      "pass dry_run:true to preview, or confirm:true to apply",
    );
  }
  return validateIssueBulkUpdateInput({
    identifiers: input.identifiers,
    patch: input.patch,
    team: input.team,
    ...(input.dry_run === undefined ? {} : { dryRun: input.dry_run }),
    ...(confirmed ? { confirmed: true } : {}),
    repoHash: cacheContext.repoHash,
    repoRoot: cacheContext.repoRoot,
  });
}

function requireIssueRepoCacheDeps(deps: unknown): IssueRepoCacheDeps {
  const candidate = deps as Partial<IssueRepoCacheDeps> | null | undefined;
  if (!candidate || typeof candidate.resolveCacheContext !== "function") {
    throw new ValidationError(
      "bulk_update_issues MCP adapter requires repo cache dependencies",
      "call the adapter with the same IssueRepoCacheDeps used by the MCP tool registration",
    );
  }
  return candidate as IssueRepoCacheDeps;
}

function validateIssueLifecycleInput(
  input: IssueLifecycleInput,
  toolName: string,
): IssueLifecycleInput {
  if (input.identifiers.length === 0) {
    throw new ValidationError(
      `${toolName} requires at least one identifiers entry`,
      "pass at least one identifiers value",
    );
  }
  return input;
}

function validateIssueBulkUpdateInput(input: IssueBulkUpdateInput): IssueBulkUpdateInput {
  return parseSurfaceInput("issues.bulk_update", issueBulkUpdateCanonicalSchema, input);
}

export async function executeIssueArchive(
  input: IssueLifecycleInput,
  deps: IssueRepoCacheDeps,
): Promise<IssueArchiveExecutionResult> {
  if (input.confirmed !== true) {
    throw new ValidationError(
      "refusing to archive issues without confirm",
      "pass --yes (CLI) or confirm:true (MCP) after verifying the archive is intended",
    );
  }
  const cacheContext = deps.resolveCacheContext(input.repoRoot);
  const results = await archiveIssues(input.identifiers);
  return {
    results,
    cache: issueCacheNotRefreshed({
      identifiers: results.filter((r) => r.status === "ok").map((r) => r.identifier),
      reason:
        "archive_issue does not refresh cached issue rows because normal issue reads may stop returning archived issues",
      repairHint:
        "CLI: run `lebop pull <id> --refresh --yes` after unarchiving and verifying local cache overwrite is intended. MCP: call `pull_issues` with refresh=true and confirm=true. Or remove stale archived rows manually.",
      repoHash: cacheContext.repoHash,
      repoRoot: cacheContext.repoRoot,
    }),
  };
}

export async function executeIssueUnarchive(
  input: IssueLifecycleInput,
  deps: IssueRepoCacheDeps,
): Promise<IssueUnarchiveExecutionResult> {
  const cacheContext = deps.resolveCacheContext(input.repoRoot);
  const results = await unarchiveIssues(input.identifiers);
  const cache = summarizeIssueCacheRefresh(
    await Promise.all(
      results
        .filter((r) => r.status === "ok")
        .map((r) => depsRefreshIssue(cacheContext, r.identifier)),
    ),
  );
  return { results, cache };
}

export async function executeIssueBulkUpdate(
  input: IssueBulkUpdateInput,
): Promise<BulkUpdateResult> {
  if (input.dryRun !== true && input.confirmed !== true) {
    throw new ValidationError(
      "refusing to bulk update issues without confirm",
      "pass dry_run to preview, or confirm/yes after verifying the batch update is intended",
    );
  }
  return bulkUpdateIssues(input);
}

async function depsRefreshIssue(
  cacheContext: IssueRepoCacheContext,
  identifier: string,
  freshIssue?: FetchedIssue,
): Promise<IssueCacheRefreshResult> {
  return refreshCachedIssueByIdentifier(identifier, {
    repoHash: cacheContext.repoHash,
    repoRoot: cacheContext.repoRoot,
    freshIssue,
  });
}

export function buildIssueArchiveMcpInputSchema(workspaceParamDescription: string) {
  return {
    identifiers: z
      .array(z.string())
      .min(1)
      .describe("Issue identifiers or ranges (TEAM-NN / TEAM-NN..TEAM-MM)."),
    confirm: z.boolean().optional().describe("Required true for destructive execution."),
    repo_root: repoRootArg.describe(
      "Override cwd-derived repo root for cache-coherence reporting.",
    ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildIssueUnarchiveMcpInputSchema(workspaceParamDescription: string) {
  return {
    identifiers: z
      .array(z.string())
      .min(1)
      .describe("Issue identifiers or ranges (TEAM-NN / TEAM-NN..TEAM-MM)."),
    repo_root: repoRootArg.describe(
      "Override cwd-derived repo root for optional cache refresh of updated rows.",
    ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildIssueBulkUpdateMcpInputSchema(workspaceParamDescription: string) {
  return {
    identifiers: z.array(z.string()).min(1).describe("Issue identifiers (TEAM-NN) to update."),
    patch: z
      .object({
        state: z.string().optional(),
        priority: z.union([z.string(), z.number()]).optional(),
        labels: z.array(z.string()).optional(),
        assignee: z.union([z.string(), z.null()]).optional(),
        estimate: z.union([z.number(), z.null()]).optional(),
        project: z.union([z.string(), z.null()]).optional(),
        milestone: z.union([z.string(), z.null()]).optional(),
        cycle: z.union([z.string(), z.null()]).optional(),
      })
      .describe("Patch to apply uniformly to each issue."),
    team: teamArg.describe(
      "Override team for state/labels resolution; otherwise derived from identifier prefix.",
    ),
    dry_run: z
      .boolean()
      .optional()
      .describe("Resolve and preview target rows without mutating Linear."),
    confirm: z
      .boolean()
      .optional()
      .describe("Required true to execute the batch update when dry_run is false or omitted."),
    repo_root: repoRootArg.describe(
      "Override cwd-derived repo root for optional cache refresh of updated rows.",
    ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export const issueArchiveOperation = {
  id: "issues.archive",
  domain: "issues",
  resource: "issue",
  action: "update",
  title: "Archive one or more issues",
  description:
    "Soft-archive one or more issues. Reverse with unarchive / unarchive_issue. NOT retry-wrapped.",
  cli: {
    command: "archive",
    liveSteps: [
      "cli:archive/unarchive issue --json",
      "cli:archive issue final --json",
      "cli:archive primary evidence issue --json",
    ],
  },
  mcp: {
    tool: "archive_issue",
    title: "Archive one or more issues",
    description:
      "Soft-archive one or more issues. Reverse with unarchive / unarchive_issue. NOT retry-wrapped.",
    annotations: {
      title: "Archive one or more issues",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildIssueArchiveInputFromCli,
  fromMcp: buildIssueArchiveInputFromMcp,
} satisfies SurfaceOperationContract<
  IssueLifecycleInput,
  IssueArchiveExecutionResult,
  IssueArchiveCliInput,
  IssueLifecycleMcpInput
>;

export const issueUnarchiveOperation = {
  id: "issues.unarchive",
  domain: "issues",
  resource: "issue",
  action: "update",
  title: "Unarchive one or more issues",
  description: "Reverse of archive_issue. NOT retry-wrapped.",
  cli: {
    command: "unarchive",
    liveSteps: ["cli:archive/unarchive issue --json", "cli:unarchive issue --json"],
  },
  mcp: {
    tool: "unarchive_issue",
    title: "Unarchive one or more issues",
    description: "Reverse of archive_issue. NOT retry-wrapped.",
    annotations: {
      title: "Unarchive one or more issues",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildIssueUnarchiveInputFromCli,
  fromMcp: buildIssueUnarchiveInputFromMcp,
} satisfies SurfaceOperationContract<
  IssueLifecycleInput,
  IssueUnarchiveExecutionResult,
  { identifiers: string[] },
  IssueLifecycleMcpInput
>;

export const issueBulkUpdateOperation = {
  id: "issues.bulk_update",
  domain: "issues",
  resource: "issue",
  action: "update",
  title: "Apply one patch uniformly to N issues",
  description:
    "Wraps Linear's issueBatchUpdate. Resolves all extras once up front, then fires a single batch mutation with partial-success rows.",
  cli: { command: "bulk update", liveSteps: ["cli:bulk update --json"] },
  mcp: {
    tool: "bulk_update_issues",
    title: "Apply one patch uniformly to N issues",
    description:
      "Batch update many issues (issueBatchUpdate). Names resolve once; partial-success rows {status, fields|error}. confirm required unless dry_run.",
    liveSemantics: "required",
    annotations: {
      title: "Apply one patch uniformly to N issues",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  fromCli: buildIssueBulkUpdateInputFromCli,
  fromMcp: (input: IssueBulkUpdateMcpInput, deps?: unknown) =>
    buildIssueBulkUpdateInputFromMcp(input, requireIssueRepoCacheDeps(deps)),
} satisfies SurfaceOperationContract<
  IssueBulkUpdateInput,
  BulkUpdateResult,
  IssueBulkUpdateCliInput,
  IssueBulkUpdateMcpInput
>;
