import chalk from "chalk";
import type { Command } from "commander";
import { findGitRoot, hashRepoRoot } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { ValidationError } from "../lib/errors.ts";
import { resolveBody } from "../lib/io.ts";
import {
  buildCommentAddInputFromCli,
  buildCommentDeleteInputFromCli,
  buildCommentListInputFromCli,
  buildCommentUpdateInputFromCli,
  type CommentCacheDeps,
  executeCommentAdd,
  executeCommentDelete,
  executeCommentList,
  executeCommentUpdate,
} from "../surface/comments.ts";

/**
 * `lebop comment add|list|update|delete` — full CRUD over Linear comments.
 *
 * Note: `comment add` replaces the legacy bare `lebop comment <id>` form.
 * For agents/scripts upgrading: prefix all your existing comment-add calls
 * with `add`. The flags (--body / --body-file / --stdin) are unchanged.
 *
 * Shared GraphQL + structured-error mapping lives in `../lib/comments.ts`.
 * Canonical normalize + execute live in `../surface/comments.ts`.
 */
export function registerComment(program: Command): void {
  const cmd = program.command("comment").description("manage comments on Linear issues");
  const cacheDeps: CommentCacheDeps = {
    channel: "cli",
    resolveCacheContext: () => currentCacheContext(),
  };

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
        throw new ValidationError(
          "empty comment body",
          "pass a non-empty body via --body, --body-file, or stdin",
        );
      }
      const result = await executeCommentAdd(
        buildCommentAddInputFromCli({ id, body, parent: opts.parent }),
        cacheDeps,
      );

      if (opts.json) {
        // Round-7 / MED-4: echo A26's full response (body/url/user) for
        // CLI/MCP parity. Pre-fix the CLI emitted only `{id, created_at}`;
        // MCP path already echoed the full shape via `result` pass-through.
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              identifier: id,
              comment: result.comment,
              cache: result.cache,
            }),
            null,
            2,
          )}\n`,
        );
        return;
      }
      process.stdout.write(
        `${chalk.green("✓")} commented on ${chalk.bold(id)}${result.comment.id ? chalk.gray(` (${result.comment.id})`) : ""}\n`,
      );
    });

  cmd
    .command("list <id>")
    .description("list comments on an issue (chronological)")
    .option("--json", "emit structured records")
    .action(async (id: string, opts: { json?: boolean }) => {
      const upperId = id.toUpperCase();
      const { comments } = await executeCommentList(buildCommentListInputFromCli({ id: upperId }));

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              issue: upperId,
              count: comments.length,
              comments,
            }),
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
        const reply = c.parent_id ? chalk.gray(` (reply to ${c.parent_id.slice(0, 8)})`) : "";
        process.stdout.write(
          `\n${chalk.dim(c.created_at)}  ${chalk.bold(who)}  ${chalk.gray(c.id)}${reply}\n${c.body}\n`,
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
        throw new ValidationError(
          "empty comment body",
          "pass a non-empty body via --body, --body-file, or stdin",
        );
      }
      const { comment: updated, cache } = await executeCommentUpdate(
        buildCommentUpdateInputFromCli({ commentId, body }),
        cacheDeps,
      );
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              comment: updated,
              cache,
            }),
            null,
            2,
          )}\n`,
        );
        return;
      }
      process.stdout.write(
        `${chalk.green("✓")} updated ${chalk.bold(commentId)} ${chalk.gray(updated.updated_at)}\n`,
      );
    });

  cmd
    .command("delete <comment-id>")
    .description("delete a comment by its UUID (irreversible — requires --yes)")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(async (commentId: string, opts: { yes?: boolean; json?: boolean }) => {
      const { status, cache } = await executeCommentDelete(
        buildCommentDeleteInputFromCli({ commentId, opts }),
        cacheDeps,
      );
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              id: commentId,
              status,
              success: status === "deleted",
              cache,
            }),
            null,
            2,
          )}\n`,
        );
        return;
      }
      if (status === "already-absent") {
        process.stdout.write(
          `${chalk.gray("✓")} already absent: ${chalk.bold(commentId)} (no-op)\n`,
        );
      } else {
        process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(commentId)}\n`);
      }
    });
}

interface AddOpts {
  body?: string;
  bodyFile?: string;
  stdin?: boolean;
  parent?: string;
  json?: boolean;
}

function currentCacheContext(): { repoHash: string; repoRoot: string | null } {
  const repoRoot = findGitRoot(process.cwd());
  return {
    repoHash: repoRoot ? hashRepoRoot(repoRoot) : "_global",
    repoRoot,
  };
}
