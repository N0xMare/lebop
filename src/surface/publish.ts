import { z } from "zod";
import { ValidationError } from "../lib/errors.ts";
import { expandIds } from "../lib/expand.ts";
import {
  type PublishLinearChangesResult,
  publishLinearChanges,
  type ReviewLinearChangesResult,
  reviewLinearChanges,
} from "../lib/linearPublish.ts";
import { parseSurfaceInput, repoRootArg, teamArg, workspaceArg } from "./schema.ts";

export interface PublishReviewInput {
  source:
    | { kind: "plan"; dir: string }
    | {
        kind: "cache";
        repoRoot?: string;
        identifiers: string[];
        projectIds: string[];
        allModified?: boolean;
      };
  team?: string;
  strict?: boolean;
}

export interface PublishApplyInput {
  reviewId: string;
  verify?: boolean;
}

export interface PublishReviewCliInput {
  ids: string[];
  opts: {
    plan?: string;
    cache?: boolean;
    projectId?: string[];
    allModified?: boolean;
    team?: string;
    strict?: boolean;
  };
}

export interface PublishApplyCliInput {
  reviewId: string;
  opts: {
    verify?: boolean;
  };
}

export type PublishReviewMcpInput = Record<string, unknown> & {
  source:
    | { kind: "plan"; dir: string }
    | {
        kind: "cache";
        repo_root?: string;
        identifiers?: string[];
        project_ids?: string[];
        all_modified?: boolean;
      };
  team?: string;
  strict?: boolean;
  workspace?: string;
};

export type PublishApplyMcpInput = Record<string, unknown> & {
  review_id: string;
  verify?: boolean;
  workspace?: string;
};

const publishPlanSourceCanonicalSchema = z
  .object({
    kind: z.literal("plan"),
    dir: z.string(),
  })
  .strict();

const publishCacheSourceCanonicalSchema = z
  .object({
    kind: z.literal("cache"),
    repoRoot: repoRootArg,
    identifiers: z.array(z.string()),
    projectIds: z.array(z.string()),
    allModified: z.boolean().optional(),
  })
  .strict();

const publishReviewCanonicalSchema: z.ZodType<PublishReviewInput> = z
  .object({
    source: z.union([publishPlanSourceCanonicalSchema, publishCacheSourceCanonicalSchema]),
    team: teamArg,
    strict: z.boolean().optional(),
  })
  .strict();

const publishApplyCanonicalSchema: z.ZodType<PublishApplyInput> = z
  .object({
    reviewId: z.string(),
    verify: z.boolean().optional(),
  })
  .strict();

const publishPlanSourceMcpSchema = z
  .object({
    kind: z.literal("plan"),
    dir: z.string(),
  })
  .strict();

const publishPlanSourceMcpToolSchema = z.object({
  kind: z.literal("plan"),
  dir: z.string(),
});

const publishCacheSourceMcpSchema = z
  .object({
    kind: z.literal("cache"),
    repo_root: repoRootArg,
    identifiers: z.array(z.string()).optional(),
    project_ids: z.array(z.string()).optional(),
    all_modified: z.boolean().optional(),
  })
  .strict();

const publishCacheSourceMcpToolSchema = z.object({
  kind: z.literal("cache"),
  repo_root: repoRootArg,
  identifiers: z.array(z.string()).optional(),
  project_ids: z.array(z.string()).optional(),
  all_modified: z.boolean().optional(),
});

export function buildPublishReviewInputFromCli(input: PublishReviewCliInput): PublishReviewInput {
  if (input.opts.cache && input.opts.plan) {
    throw new ValidationError(
      "pass exactly one of --plan or --cache",
      "choose --plan for plan directories or --cache for modified local cache rows",
    );
  }
  if (!input.opts.cache && !input.opts.plan) {
    throw new ValidationError(
      "publish review requires --plan <dir> or --cache",
      "choose --plan for plan directories or --cache for modified local cache rows",
    );
  }

  return parseSurfaceInput("publish.review", publishReviewCanonicalSchema, {
    source: input.opts.cache
      ? {
          kind: "cache",
          identifiers: expandIds(input.ids),
          projectIds: input.opts.projectId ?? [],
          allModified: input.opts.allModified,
        }
      : { kind: "plan", dir: input.opts.plan ?? "" },
    team: input.opts.team,
    strict: input.opts.strict,
  });
}

export function buildPublishApplyInputFromCli(input: PublishApplyCliInput): PublishApplyInput {
  return parseSurfaceInput("publish.apply", publishApplyCanonicalSchema, {
    reviewId: input.reviewId,
    verify: input.opts.verify,
  });
}

export function buildPublishReviewInputFromMcp(input: PublishReviewMcpInput): PublishReviewInput {
  const parsed = parseSurfaceInput(
    "publish.review.mcp",
    z
      .object({
        source: z.union([publishPlanSourceMcpSchema, publishCacheSourceMcpSchema]),
        team: teamArg,
        strict: z.boolean().optional(),
      })
      .strict(),
    {
      source: input.source,
      team: input.team,
      strict: input.strict,
    },
  );

  return parseSurfaceInput("publish.review", publishReviewCanonicalSchema, {
    source:
      parsed.source.kind === "cache"
        ? {
            kind: "cache",
            repoRoot: parsed.source.repo_root,
            identifiers: expandIds(parsed.source.identifiers ?? []),
            projectIds: parsed.source.project_ids ?? [],
            allModified: parsed.source.all_modified,
          }
        : parsed.source,
    team: parsed.team,
    strict: parsed.strict,
  });
}

export function buildPublishApplyInputFromMcp(input: PublishApplyMcpInput): PublishApplyInput {
  return parseSurfaceInput("publish.apply", publishApplyCanonicalSchema, {
    reviewId: input.review_id,
    verify: input.verify,
  });
}

export function buildPublishReviewMcpInputSchema(workspaceParamDescription: string) {
  return {
    source: z
      .union([publishPlanSourceMcpToolSchema, publishCacheSourceMcpToolSchema])
      .describe(
        "Source to review. Use {kind:'plan', dir} for plan directories or {kind:'cache', identifiers?, project_ids?, all_modified?, repo_root?} for modified cache rows. Cache reviews require identifiers, project_ids, or all_modified:true; do not combine all_modified with explicit targets.",
      ),
    team: teamArg.describe("Override the resolved team."),
    strict: z.boolean().optional().describe("Treat lint warnings as blockers."),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildPublishApplyMcpInputSchema(workspaceParamDescription: string) {
  return {
    review_id: z.string().describe("Review id returned by review_linear_changes."),
    verify: z.boolean().optional().describe("Default true. Run plan diff after publish."),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export async function executePublishReview(
  input: PublishReviewInput,
): Promise<ReviewLinearChangesResult> {
  return reviewLinearChanges({
    source:
      input.source.kind === "cache"
        ? {
            kind: "cache",
            repo_root: input.source.repoRoot,
            identifiers: input.source.identifiers,
            project_ids: input.source.projectIds,
            all_modified: input.source.allModified,
          }
        : input.source,
    team: input.team,
    strict: input.strict,
  });
}

export async function executePublishApply(
  input: PublishApplyInput,
): Promise<PublishLinearChangesResult> {
  return publishLinearChanges({
    reviewId: input.reviewId,
    verify: input.verify,
  });
}

export const publishReviewOperation = {
  id: "publish.review",
  domain: "publish",
  resource: "review",
  action: "review",
  title: "Review Linear changes",
  description:
    "Validate, lint, diff/dry-run, and store a publish review for plan directories or modified cache rows.",
  cli: {
    command: "publish review",
    liveSteps: [
      "cli:publish review cache issue --json",
      "cli:publish review cache project --json",
      "cli:publish review --plan --json",
    ],
  },
  mcp: {
    tool: "review_linear_changes",
    title: "Review a Linear publish operation",
    description:
      "Task-shaped write review for agent-authored plan directories or modified cache rows: validate, lint, diff/dry-run, and store a review_id for later publish.",
    annotations: {
      title: "Review a Linear publish operation",
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaKeys: ["source", "strict", "team", "workspace"],
    liveSemantics: "required",
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
    confirm: "not_required",
  },
  behaviorContractKind: "publish",
  fromCli: buildPublishReviewInputFromCli,
  fromMcp: buildPublishReviewInputFromMcp,
  execute: executePublishReview,
} as const;

export const publishApplyOperation = {
  id: "publish.apply",
  domain: "publish",
  resource: "apply",
  action: "publish",
  title: "Publish Linear changes",
  description:
    "Publish a stored review_id, write server-normalized state back locally, and optionally verify the outcome.",
  cli: {
    command: "publish apply",
    liveSteps: [
      "cli:publish apply cache issue --json",
      "cli:publish apply cache project --json",
      "cli:publish apply --json",
    ],
  },
  mcp: {
    tool: "publish_linear_changes",
    title: "Publish Linear changes and verify the outcome",
    description:
      "Publishes a stored review_id: validates reviewed local content, applies Linear mutations, writes server-normalized state back, then verifies outcome.",
    annotations: {
      title: "Publish Linear changes and verify the outcome",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaKeys: ["review_id", "verify", "workspace"],
    liveSemantics: "required",
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
    confirm: "not_required",
  },
  behaviorContractKind: "publish",
  fromCli: buildPublishApplyInputFromCli,
  fromMcp: buildPublishApplyInputFromMcp,
  execute: executePublishApply,
} as const;

export const PUBLISH_SURFACE_OPERATIONS = [publishReviewOperation, publishApplyOperation] as const;
