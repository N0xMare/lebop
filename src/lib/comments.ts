/**
 * Comment CRUD over Linear's Comment type. Wraps the GraphQL queries +
 * mutations so both the CLI (`commands/comment.ts`) and the MCP server
 * call the same lib path.
 */

import { NotFoundError, ValidationError } from "./errors.ts";
import { requireMutationEntity, requireMutationSuccess } from "./mutationResult.ts";
import { paginateRaw, paginateRawPage } from "./paginate.ts";
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
      comment {
        id
        body
        url
        updatedAt
        user { id name email }
      }
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

export async function listComments(
  identifier: string,
  opts: { max?: number } = {},
): Promise<ListedComment[]> {
  const client = await linear();
  const upperId = identifier.toUpperCase();
  let missingIssue = false;
  const nodes = await paginateRaw<CommentNode, CommentsPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_COMMENTS_QUERY, {
        id: upperId,
        first,
        after,
      }) as Promise<CommentsPage>,
    (response) => {
      if (!response.data.issue) {
        missingIssue = true;
        return null;
      }
      return response.data.issue.comments;
    },
    { pageSize: 250, max: opts.max },
  );
  if (missingIssue) {
    throw new NotFoundError(`issue not found: ${upperId}`, "verify the identifier exists");
  }
  return nodes.map(shape);
}

export async function listCommentsPage(
  identifier: string,
  opts: { first: number; after?: string } = { first: 250 },
): Promise<{
  comments: ListedComment[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}> {
  const client = await linear();
  const upperId = identifier.toUpperCase();
  let missingIssue = false;
  const page = await paginateRawPage<CommentNode, CommentsPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_COMMENTS_QUERY, {
        id: upperId,
        first,
        after,
      }) as Promise<CommentsPage>,
    (response) => {
      if (!response.data.issue) {
        missingIssue = true;
        return null;
      }
      return response.data.issue.comments;
    },
    { limit: opts.first, after: opts.after, pageSize: 250 },
  );
  if (missingIssue) {
    throw new NotFoundError(`issue not found: ${upperId}`, "verify the identifier exists");
  }
  return {
    comments: page.nodes.map(shape),
    pageInfo: page.pageInfo,
  };
}

export interface AddCommentInput {
  identifier: string;
  body: string;
  /** UUID of the parent comment when replying. */
  parentId?: string;
}

export interface AddCommentResult {
  id: string;
  created_at: string | null;
  // Round-6 / A26: thicker response shape — pre-fix callers needed a
  // follow-up `list_comments` to discover the URL / echo the body / find
  // the author. Additive — strictly more information at the same wire
  // cost (createComment already loads the comment node for the response).
  body: string | null;
  url: string | null;
  user: { id: string; name: string; email: string } | null;
}

export async function addComment(input: AddCommentInput): Promise<AddCommentResult> {
  if (!input.body.trim()) {
    throw new ValidationError(
      "empty comment body",
      "pass a non-empty body via --body, --body-file, stdin, or MCP body",
    );
  }
  // Resolution wrapped (idempotent); createComment NOT wrapped — retry-after-
  // success would post a duplicate.
  const issue = await withClient((c) => c.issue(input.identifier));
  if (!issue) {
    throw new NotFoundError(
      `issue not found: ${input.identifier}`,
      "verify the identifier or your team scope",
    );
  }

  const client = await linear();
  const linearInput: { issueId: string; body: string; parentId?: string } = {
    issueId: issue.id,
    body: input.body,
  };
  if (input.parentId) linearInput.parentId = input.parentId;
  const payload = await client.createComment(linearInput);
  if (!payload.success) {
    // Linear's `commentCreate` returns `success: false` when the input is
    // structurally fine but Linear rejected the comment (e.g. the issue is
    // archived, the body violates a workspace rule, the parent comment is
    // gone). Surface as a structured ValidationError so the CLI / MCP layer
    // can format it consistently.
    throw new ValidationError(
      `Linear rejected the comment on ${input.identifier}`,
      "check that the issue is not archived and that the body / parent comment are valid",
    );
  }
  const created = await payload.comment;
  if (!created?.id) {
    throw new ValidationError(
      "commentCreate did not return comment",
      "Linear returned success:true without a comment id; retry after checking Linear state",
    );
  }
  const createdAt = created?.createdAt;
  const user = created ? await created.user : null;
  return {
    id: created.id,
    created_at:
      createdAt instanceof Date
        ? createdAt.toISOString()
        : ((createdAt as string | undefined) ?? null),
    body: created?.body ?? null,
    url: created?.url ?? null,
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
        }
      : null,
  };
}

export interface UpdateCommentResult {
  id: string;
  updated_at: string;
  // Round-7 / H-MCP-2: A26 parity for the update path. Pre-fix callers had
  // to do a follow-up `list_comments` to read the body/URL/user. Additive —
  // strictly more information at the same wire cost (commentUpdate already
  // loads the comment node for the response).
  body: string | null;
  url: string | null;
  user: { id: string; name: string; email: string } | null;
}

export async function updateComment(commentId: string, body: string): Promise<UpdateCommentResult> {
  if (!body.trim()) {
    throw new ValidationError(
      "empty comment body",
      "pass a non-empty body via --body, --body-file, stdin, or MCP body",
    );
  }
  // Idempotent at the value level — retry-wrapped.
  const response = (await withClient((c) =>
    c.client.rawRequest(UPDATE_COMMENT_MUTATION, { id: commentId, input: { body } }),
  )) as {
    data: {
      commentUpdate: {
        success: boolean;
        comment: {
          id: string;
          body: string | null;
          url: string | null;
          updatedAt: string;
          user: { id: string; name: string; email: string } | null;
        };
      };
    };
  };
  const updated = requireMutationEntity<(typeof response.data.commentUpdate)["comment"]>(
    "commentUpdate",
    response.data.commentUpdate,
    "comment",
  );
  return {
    id: updated.id,
    updated_at: updated.updatedAt,
    body: updated.body,
    url: updated.url,
    user: updated.user,
  };
}

export async function deleteComment(commentId: string): Promise<boolean> {
  // NOT wrapped — re-running after success would surface as not-found.
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_COMMENT_MUTATION, {
    id: commentId,
  })) as { data: { commentDelete: { success: boolean } } };
  requireMutationSuccess("commentDelete", response.data.commentDelete);
  return true;
}
