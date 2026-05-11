/**
 * Comment CRUD over Linear's Comment type. Wraps the GraphQL queries +
 * mutations so both the CLI (`commands/comment.ts`) and the MCP server
 * call the same lib path.
 */

import { paginateRaw } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedComment {
  id: string;
  body: string;
  created_at: string;
  updated_at: string;
  user: { id: string; name: string; email: string } | null;
  parent_id: string | null;
}

interface CommentNode {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; email: string } | null;
  parent: { id: string } | null;
}

interface CommentsPage {
  data: {
    issue: {
      comments: {
        nodes: CommentNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  };
}

const LIST_COMMENTS_QUERY = /* GraphQL */ `
  query ListComments($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      comments(first: $first, after: $after) {
        nodes {
          id
          body
          createdAt
          updatedAt
          user { id name email }
          parent { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const UPDATE_COMMENT_MUTATION = /* GraphQL */ `
  mutation UpdateComment($id: String!, $input: CommentUpdateInput!) {
    commentUpdate(id: $id, input: $input) {
      success
      comment { id updatedAt }
    }
  }
`;

const DELETE_COMMENT_MUTATION = /* GraphQL */ `
  mutation DeleteComment($id: String!) {
    commentDelete(id: $id) { success }
  }
`;

function shape(c: CommentNode): ListedComment {
  return {
    id: c.id,
    body: c.body,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    user: c.user,
    parent_id: c.parent?.id ?? null,
  };
}

export async function listComments(identifier: string): Promise<ListedComment[]> {
  const client = await linear();
  const upperId = identifier.toUpperCase();
  const nodes = await paginateRaw<CommentNode, CommentsPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_COMMENTS_QUERY, {
        id: upperId,
        first,
        after,
      }) as Promise<CommentsPage>,
    (response) => response.data.issue?.comments ?? null,
    { pageSize: 250 },
  );
  return nodes.map(shape);
}

export interface AddCommentInput {
  identifier: string;
  body: string;
  /** UUID of the parent comment when replying. */
  parentId?: string;
}

export interface AddCommentResult {
  id: string | null;
  created_at: string | null;
}

export async function addComment(input: AddCommentInput): Promise<AddCommentResult> {
  // Resolution wrapped (idempotent); createComment NOT wrapped — retry-after-
  // success would post a duplicate.
  const issue = await withClient((c) => c.issue(input.identifier));
  if (!issue) throw new Error(`issue not found: ${input.identifier}`);

  const client = await linear();
  const linearInput: { issueId: string; body: string; parentId?: string } = {
    issueId: issue.id,
    body: input.body,
  };
  if (input.parentId) linearInput.parentId = input.parentId;
  const payload = await client.createComment(linearInput);
  if (!payload.success) {
    throw new Error(`Linear rejected the comment on ${input.identifier}`);
  }
  const created = await payload.comment;
  const createdAt = created?.createdAt;
  return {
    id: created?.id ?? null,
    created_at:
      createdAt instanceof Date
        ? createdAt.toISOString()
        : ((createdAt as string | undefined) ?? null),
  };
}

export interface UpdateCommentResult {
  id: string;
  updated_at: string;
}

export async function updateComment(commentId: string, body: string): Promise<UpdateCommentResult> {
  // Idempotent at the value level — retry-wrapped.
  const response = (await withClient((c) =>
    c.client.rawRequest(UPDATE_COMMENT_MUTATION, { id: commentId, input: { body } }),
  )) as {
    data: {
      commentUpdate: {
        success: boolean;
        comment: { id: string; updatedAt: string };
      };
    };
  };
  const updated = response.data.commentUpdate.comment;
  return { id: updated.id, updated_at: updated.updatedAt };
}

export async function deleteComment(commentId: string): Promise<boolean> {
  // NOT wrapped — re-running after success would surface as not-found.
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_COMMENT_MUTATION, {
    id: commentId,
  })) as { data: { commentDelete: { success: boolean } } };
  return response.data.commentDelete.success;
}
