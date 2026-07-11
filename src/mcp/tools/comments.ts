import { envelope } from "../../lib/envelope.ts";
import {
  buildCommentAddInputFromMcp,
  buildCommentAddMcpInputSchema,
  buildCommentDeleteInputFromMcp,
  buildCommentDeleteMcpInputSchema,
  buildCommentListInputFromMcp,
  buildCommentListMcpInputSchema,
  buildCommentUpdateInputFromMcp,
  buildCommentUpdateMcpInputSchema,
  type CommentAddMcpInput,
  type CommentCacheDeps,
  type CommentDeleteMcpInput,
  type CommentListMcpInput,
  type CommentUpdateMcpInput,
  commentAddOperation,
  commentDeleteOperation,
  commentListOperation,
  commentUpdateOperation,
  executeCommentAdd,
  executeCommentDelete,
  executeCommentList,
  executeCommentUpdate,
} from "../../surface/comments.ts";
import { resolveMcpRepoCacheContext } from "../common.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface CommentToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

const mcpCacheDeps: CommentCacheDeps = {
  channel: "mcp",
  resolveCacheContext: (repoRoot) => resolveMcpRepoCacheContext(repoRoot),
};

export function buildCommentToolSpecs(deps: CommentToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_comments",
      config: mcpToolConfig(
        commentListOperation,
        buildCommentListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CommentListMcpInput) => {
        const { comments } = await executeCommentList(buildCommentListInputFromMcp(args));
        return text(
          envelope({
            identifier: args.identifier,
            count: comments.length,
            comments,
          }),
        );
      },
    },
    {
      name: "add_comment",
      config: mcpToolConfig(
        commentAddOperation,
        buildCommentAddMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CommentAddMcpInput) => {
        const result = await executeCommentAdd(buildCommentAddInputFromMcp(args), mcpCacheDeps);
        return text(
          envelope({
            identifier: args.identifier,
            comment: result.comment,
            cache: result.cache,
          }),
        );
      },
    },
    {
      name: "update_comment",
      config: mcpToolConfig(
        commentUpdateOperation,
        buildCommentUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CommentUpdateMcpInput) => {
        const result = await executeCommentUpdate(
          buildCommentUpdateInputFromMcp(args),
          mcpCacheDeps,
        );
        return text(envelope({ comment: result.comment, cache: result.cache }));
      },
    },
    {
      name: "delete_comment",
      config: mcpToolConfig(
        commentDeleteOperation,
        buildCommentDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CommentDeleteMcpInput) => {
        deps.requireConfirm(args, "delete_comment");
        const result = await executeCommentDelete(
          buildCommentDeleteInputFromMcp(args),
          mcpCacheDeps,
        );
        return text(
          envelope({
            id: result.id,
            status: result.status,
            success: result.success,
            cache: result.cache,
          }),
        );
      },
    },
  ];
}
