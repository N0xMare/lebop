import { z } from "zod";
import {
  commentCacheNotRefreshed,
  type IssueCacheNotRefreshedSummary,
  issueCacheNotRefreshed,
} from "../lib/cacheCoherence.ts";
import {
  type AddCommentResult,
  addComment,
  deleteComment,
  type ListedComment,
  listComments,
  type UpdateCommentResult,
  updateComment,
} from "../lib/comments.ts";
import { tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, repoRootArg, workspaceArg } from "./schema.ts";

export type CommentChannel = "cli" | "mcp";

export interface CommentCacheContext {
  repoHash: string;
  repoRoot: string | null;
}

export interface CommentCacheDeps {
  channel: CommentChannel;
  resolveCacheContext: (repoRoot: string | undefined) => CommentCacheContext;
}

export interface CommentListInput {
  identifier: string;
}

export interface CommentListCliInput {
  id: string;
}

export type CommentListMcpInput = Record<string, unknown> & {
  identifier: string;
};

export interface CommentListResult {
  comments: ListedComment[];
}

export interface CommentAddInput {
  identifier: string;
  body: string;
  parentId?: string;
  repoRoot?: string;
}

export interface CommentAddCliInput {
  id: string;
  body: string;
  parent?: string;
}

export type CommentAddMcpInput = Record<string, unknown> & {
  identifier: string;
  body: string;
  parent_id?: string;
  repo_root?: string;
};

export interface CommentAddResult {
  identifier: string;
  comment: AddCommentResult;
  cache: IssueCacheNotRefreshedSummary;
}

export interface CommentUpdateInput {
  id: string;
  body: string;
  repoRoot?: string;
}

export interface CommentUpdateCliInput {
  commentId: string;
  body: string;
}

export type CommentUpdateMcpInput = Record<string, unknown> & {
  id: string;
  body: string;
  repo_root?: string;
};

export interface CommentUpdateExecutionResult {
  comment: UpdateCommentResult;
  cache: IssueCacheNotRefreshedSummary;
}

export interface CommentDeleteInput {
  id: string;
  repoRoot?: string;
}

export interface CommentDeleteCliInput {
  commentId: string;
  opts: {
    yes?: boolean;
  };
}

export type CommentDeleteMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
  repo_root?: string;
};

export interface CommentDeleteResult {
  id: string;
  status: "deleted" | "already-absent";
  success: boolean;
  cache: IssueCacheNotRefreshedSummary;
}

const commentListCanonicalSchema = z.object({ identifier: z.string().min(1) }).strict();

const commentAddCanonicalSchema = z
  .object({
    identifier: z.string().min(1),
    body: z.string(),
    parentId: z.string().optional(),
    repoRoot: repoRootArg,
  })
  .strict();

const commentUpdateCanonicalSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    repoRoot: repoRootArg,
  })
  .strict();

const commentDeleteCanonicalSchema = z
  .object({
    id: z.string().min(1),
    repoRoot: repoRootArg,
  })
  .strict();

export function buildCommentListInputFromCli(input: CommentListCliInput): CommentListInput {
  return parseSurfaceInput("comments.list", commentListCanonicalSchema, {
    identifier: input.id,
  });
}

export function buildCommentListInputFromMcp(input: CommentListMcpInput): CommentListInput {
  return parseSurfaceInput("comments.list", commentListCanonicalSchema, {
    identifier: input.identifier,
  });
}

export function buildCommentAddInputFromCli(input: CommentAddCliInput): CommentAddInput {
  return parseSurfaceInput("comments.add", commentAddCanonicalSchema, {
    identifier: input.id,
    body: input.body,
    parentId: input.parent,
  });
}

export function buildCommentAddInputFromMcp(input: CommentAddMcpInput): CommentAddInput {
  return parseSurfaceInput("comments.add", commentAddCanonicalSchema, {
    identifier: input.identifier,
    body: input.body,
    parentId: input.parent_id,
    repoRoot: input.repo_root,
  });
}

export function buildCommentUpdateInputFromCli(input: CommentUpdateCliInput): CommentUpdateInput {
  return parseSurfaceInput("comments.update", commentUpdateCanonicalSchema, {
    id: input.commentId,
    body: input.body,
  });
}

export function buildCommentUpdateInputFromMcp(input: CommentUpdateMcpInput): CommentUpdateInput {
  return parseSurfaceInput("comments.update", commentUpdateCanonicalSchema, {
    id: input.id,
    body: input.body,
    repoRoot: input.repo_root,
  });
}

export function buildCommentDeleteInputFromCli(input: CommentDeleteCliInput): CommentDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to delete comment ${input.commentId} without --yes`,
      "re-run with --yes to confirm. This operation is irreversible.",
    );
  }
  return parseSurfaceInput("comments.delete", commentDeleteCanonicalSchema, {
    id: input.commentId,
  });
}

export function buildCommentDeleteInputFromMcp(input: CommentDeleteMcpInput): CommentDeleteInput {
  return parseSurfaceInput("comments.delete", commentDeleteCanonicalSchema, {
    id: input.id,
    repoRoot: input.repo_root,
  });
}

export async function executeCommentList(input: CommentListInput): Promise<CommentListResult> {
  const comments = await listComments(input.identifier);
  return { comments };
}

export async function executeCommentAdd(
  input: CommentAddInput,
  deps: CommentCacheDeps,
): Promise<CommentAddResult> {
  const cacheContext = deps.resolveCacheContext(input.repoRoot);
  const comment = await addComment({
    identifier: input.identifier,
    body: input.body,
    parentId: input.parentId,
  });
  const upper = input.identifier.toUpperCase();
  return {
    identifier: input.identifier,
    comment,
    cache: issueCacheNotRefreshed({
      identifiers: [upper],
      reason: "comment add does not rewrite the cached issue comment collection in place",
      repairHint:
        deps.channel === "cli"
          ? `run \`lebop pull ${upper} --refresh --yes\` to refresh cached comments after verifying local cache overwrite is intended`
          : `call pull_issues with identifiers=[${JSON.stringify(upper)}], refresh=true, confirm=true to refresh cached comments after verifying local cache overwrite is intended`,
      repoHash: cacheContext.repoHash,
      repoRoot: cacheContext.repoRoot,
    }),
  };
}

export async function executeCommentUpdate(
  input: CommentUpdateInput,
  deps: CommentCacheDeps,
): Promise<CommentUpdateExecutionResult> {
  const cacheContext = deps.resolveCacheContext(input.repoRoot);
  const comment = await updateComment(input.id, input.body);
  return {
    comment,
    cache: commentCacheNotRefreshed({
      commentIds: [input.id],
      reason:
        "comment update receives only a comment UUID and does not know which cached issue comment collection to refresh",
      repairHint:
        deps.channel === "cli"
          ? "run `lebop pull <issue-id> --refresh --yes` for the parent issue before relying on cached comments, after verifying local cache overwrite is intended"
          : "call pull_issues with the parent issue identifier, refresh=true, confirm=true before relying on cached comments, after verifying local cache overwrite is intended",
      repoHash: cacheContext.repoHash,
      repoRoot: cacheContext.repoRoot,
    }),
  };
}

export async function executeCommentDelete(
  input: CommentDeleteInput,
  deps: CommentCacheDeps,
): Promise<CommentDeleteResult> {
  const cacheContext = deps.resolveCacheContext(input.repoRoot);
  const { status } = await tryIdempotentDelete(() => deleteComment(input.id));
  return {
    id: input.id,
    status,
    success: status === "deleted",
    cache: commentCacheNotRefreshed({
      commentIds: [input.id],
      reason:
        "comment delete receives only a comment UUID and does not know which cached issue comment collection to refresh",
      repairHint:
        deps.channel === "cli"
          ? "run `lebop pull <issue-id> --refresh --yes` for the parent issue before relying on cached comments, after verifying local cache overwrite is intended"
          : "call pull_issues with the parent issue identifier, refresh=true, confirm=true before relying on cached comments, after verifying local cache overwrite is intended",
      repoHash: cacheContext.repoHash,
      repoRoot: cacheContext.repoRoot,
    }),
  };
}

export const commentListOperation = {
  id: "comments.list",
  domain: "comments",
  resource: "comment",
  action: "list",
  title: "List comments on an issue",
  description: "Returns all comments on the given issue, chronologically.",
  cli: {
    command: "comment list",
    liveSteps: ["cli:comment list --json"],
  },
  mcp: {
    tool: "list_comments",
    title: "List comments on an issue",
    description: "Returns all comments on the given issue, chronologically.",
    annotations: {
      title: "List comments on an issue",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["identifier", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes: "CLI --json uses envelope key `issue`; MCP uses `identifier`. Adapter payload shape only.",
  fromCli: buildCommentListInputFromCli,
  fromMcp: buildCommentListInputFromMcp,
  execute: executeCommentList,
} satisfies SurfaceOperationContract<
  CommentListInput,
  CommentListResult,
  CommentListCliInput,
  CommentListMcpInput
>;

export const commentAddOperation = {
  id: "comments.add",
  domain: "comments",
  resource: "comment",
  action: "create",
  title: "Add a comment to an issue",
  description: "Posts one comment. NOT retry-wrapped — would post a duplicate.",
  cli: {
    command: "comment add",
    liveSteps: ["cli:comment add --json", "cli:comment add reply --json"],
  },
  mcp: {
    tool: "add_comment",
    title: "Add a comment to an issue",
    description: "Posts one comment. NOT retry-wrapped — would post a duplicate.",
    annotations: {
      title: "Add a comment to an issue",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaKeys: ["identifier", "body", "parent_id", "repo_root", "workspace"],
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  fromCli: buildCommentAddInputFromCli,
  fromMcp: buildCommentAddInputFromMcp,
} satisfies SurfaceOperationContract<
  CommentAddInput,
  CommentAddResult,
  CommentAddCliInput,
  CommentAddMcpInput
>;

export const commentUpdateOperation = {
  id: "comments.update",
  domain: "comments",
  resource: "comment",
  action: "update",
  title: "Update an existing comment",
  description: "Idempotent at the value level — safe to retry.",
  cli: {
    command: "comment update",
    liveSteps: ["cli:comment update --json"],
  },
  mcp: {
    tool: "update_comment",
    title: "Update an existing comment",
    description: "Idempotent at the value level — safe to retry.",
    annotations: {
      title: "Update an existing comment",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "body", "repo_root", "workspace"],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildCommentUpdateInputFromCli,
  fromMcp: buildCommentUpdateInputFromMcp,
} satisfies SurfaceOperationContract<
  CommentUpdateInput,
  CommentUpdateExecutionResult,
  CommentUpdateCliInput,
  CommentUpdateMcpInput
>;

export const commentDeleteOperation = {
  id: "comments.delete",
  domain: "comments",
  resource: "comment",
  action: "delete",
  title: "Delete a comment by UUID",
  description:
    "Delete a comment by UUID. Idempotent — re-deleting an already-absent comment returns `{status: 'already-absent'}`.",
  cli: {
    command: "comment delete",
    liveSteps: ["cli:comment delete reply --json", "cli:comment delete --json"],
  },
  mcp: {
    tool: "delete_comment",
    title: "Delete a comment by UUID",
    description:
      "Delete a comment by UUID. Idempotent — re-deleting an already-absent comment returns `{status: 'already-absent'}`.",
    annotations: {
      title: "Delete a comment by UUID",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "confirm", "repo_root", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildCommentDeleteInputFromCli,
  fromMcp: buildCommentDeleteInputFromMcp,
} satisfies SurfaceOperationContract<
  CommentDeleteInput,
  CommentDeleteResult,
  CommentDeleteCliInput,
  CommentDeleteMcpInput
>;

export const COMMENT_SURFACE_OPERATIONS = [
  commentListOperation,
  commentAddOperation,
  commentUpdateOperation,
  commentDeleteOperation,
] as const;

export function buildCommentListMcpInputSchema(workspaceDescription: string) {
  return {
    identifier: z.string().describe("Issue identifier (TEAM-NN)."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCommentAddMcpInputSchema(workspaceDescription: string) {
  return {
    identifier: z.string().describe("Issue identifier (TEAM-NN)."),
    body: z.string(),
    parent_id: z.string().optional().describe("UUID of parent comment when replying."),
    repo_root: z
      .string()
      .optional()
      .describe("Override cwd-derived repo root for cache-coherence reporting."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCommentUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Comment UUID (visible in list_comments)."),
    body: z.string(),
    repo_root: z
      .string()
      .optional()
      .describe("Override cwd-derived repo root for cache-coherence reporting."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCommentDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Comment UUID."),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    repo_root: z
      .string()
      .optional()
      .describe("Override cwd-derived repo root for cache-coherence reporting."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}
