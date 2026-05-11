import chalk from "chalk";
import type { Command } from "commander";
import { resolveBody } from "../lib/io.ts";
import { paginateRaw } from "../lib/paginate.ts";
import { linear, withClient } from "../lib/sdk.ts";

/**
 * `lebop comment add|list|update|delete` — full CRUD over Linear comments.
 *
 * Note: `comment add` replaces the legacy bare `lebop comment <id>` form.
 * For agents/scripts upgrading: prefix all your existing comment-add calls
 * with `add`. The flags (--body / --body-file / --stdin) are unchanged.
 */
export function registerComment(program: Command): void {
  const cmd = program.command("comment").description("manage comments on Linear issues");

  cmd
    .command("add <id>")
    .description("add a comment to an issue")
    .option("--body <text>", "comment body (inline)")
    .option("--body-file <path>", "read body from a file")
    .option("--stdin", "read body from stdin")
    .option("--parent <comment-id>", "reply to a comment (threads)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: AddOpts) => {
      const body = await resolveBody(opts);
      if (!body.trim()) {
        throw new Error("empty comment body");
      }

      // Read is wrapped (idempotent); the createComment mutation is NOT
      // wrapped — retry-after-success would post a duplicate.
      const issue = await withClient((c) => c.issue(id));
      if (!issue) throw new Error(`issue not found: ${id}`);

      const client = await linear();
      const input: { issueId: string; body: string; parentId?: string } = {
        issueId: issue.id,
        body,
      };
      if (opts.parent) input.parentId = opts.parent;
      const payload = await client.createComment(input);
      if (!payload.success) {
        throw new Error(`Linear rejected the comment on ${id}`);
      }
      const created = await payload.comment;

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              issue: id,
              comment: { id: created?.id ?? null, created_at: created?.createdAt ?? null },
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      process.stdout.write(
        `${chalk.green("✓")} commented on ${chalk.bold(id)}${created?.id ? chalk.gray(` (${created.id})`) : ""}\n`,
      );
    });

  cmd
    .command("list <id>")
    .description("list comments on an issue (chronological)")
    .option("--json", "emit structured records")
    .action(async (id: string, opts: { json?: boolean }) => {
      const upperId = id.toUpperCase();
      type CommentNode = {
        id: string;
        body: string;
        createdAt: string;
        updatedAt: string;
        user: { id: string; name: string; email: string } | null;
        parent: { id: string } | null;
      };
      type CommentsPage = {
        data: {
          issue: {
            comments: {
              nodes: CommentNode[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          } | null;
        };
      };
      const client = await linear();
      const comments = await paginateRaw<CommentNode, CommentsPage>(
        ({ first, after }) =>
          client.client.rawRequest(LIST_COMMENTS_QUERY, {
            id: upperId,
            first,
            after,
          }) as Promise<CommentsPage>,
        (response) => response.data.issue?.comments ?? null,
        { pageSize: 250 },
      );

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              issue: upperId,
              count: comments.length,
              comments,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      if (comments.length === 0) {
        process.stdout.write(`${chalk.gray("(no comments)")}\n`);
        return;
      }
      for (const c of comments) {
        const who = c.user ? `${c.user.name} <${c.user.email}>` : "unknown";
        const reply = c.parent ? chalk.gray(` (reply to ${c.parent.id.slice(0, 8)})`) : "";
        process.stdout.write(
          `\n${chalk.dim(c.createdAt)}  ${chalk.bold(who)}  ${chalk.gray(c.id)}${reply}\n${c.body}\n`,
        );
      }
    });

  cmd
    .command("update <comment-id>")
    .description("edit an existing comment by its UUID (idempotent)")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--stdin", "read body from stdin")
    .option("--json", "emit structured result")
    .action(async (commentId: string, opts: AddOpts) => {
      const body = await resolveBody(opts);
      if (!body.trim()) {
        throw new Error("empty comment body");
      }
      const response = (await withClient((c) =>
        c.client.rawRequest(UPDATE_COMMENT_MUTATION, {
          id: commentId,
          input: { body },
        }),
      )) as {
        data: {
          commentUpdate: {
            success: boolean;
            comment: { id: string; updatedAt: string };
          };
        };
      };
      const updated = response.data.commentUpdate.comment;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            { schema_version: 1, comment: { id: updated.id, updated_at: updated.updatedAt } },
            null,
            2,
          )}\n`,
        );
        return;
      }
      process.stdout.write(
        `${chalk.green("✓")} updated ${chalk.bold(commentId)} ${chalk.gray(updated.updatedAt)}\n`,
      );
    });

  cmd
    .command("delete <comment-id>")
    .description("delete a comment by its UUID")
    .option("--json", "emit structured result")
    .action(async (commentId: string, opts: { json?: boolean }) => {
      // Delete is NOT wrapped with retry — re-running after first success
      // would surface as "not found" since the comment is already gone.
      const client = await linear();
      const response = (await client.client.rawRequest(DELETE_COMMENT_MUTATION, {
        id: commentId,
      })) as { data: { commentDelete: { success: boolean } } };
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              comment_id: commentId,
              success: response.data.commentDelete.success,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(commentId)}\n`);
    });
}

interface AddOpts {
  body?: string;
  bodyFile?: string;
  stdin?: boolean;
  parent?: string;
  json?: boolean;
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
