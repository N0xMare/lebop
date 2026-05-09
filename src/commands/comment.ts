import chalk from "chalk";
import type { Command } from "commander";
import { linear, withClient } from "../lib/sdk.ts";

export function registerComment(program: Command): void {
  program
    .command("comment <id>")
    .description("add a comment to an issue")
    .option("--body <text>", "comment body (inline)")
    .option("--body-file <path>", "read body from a file")
    .option("--stdin", "read body from stdin")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: CommentOpts) => {
      const body = await resolveBody(opts);
      if (!body.trim()) {
        throw new Error("empty comment body");
      }

      // Read is wrapped (idempotent); the comment-creation itself is NOT
      // wrapped — retry-after-success would post a duplicate.
      const issue = await withClient((c) => c.issue(id));
      if (!issue) throw new Error(`issue not found: ${id}`);

      const client = await linear();
      const payload = await client.createComment({ issueId: issue.id, body });
      if (!payload.success) {
        throw new Error(`Linear rejected the comment on ${id}`);
      }
      // payload.comment is a lazy getter (Promise<Comment> | undefined);
      // left bare — it's purely informational (id + createdAt for output).
      const created = await payload.comment;

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              issue: id,
              comment: {
                id: created?.id ?? null,
                created_at: created?.createdAt ?? null,
              },
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
}

interface CommentOpts {
  body?: string;
  bodyFile?: string;
  stdin?: boolean;
  json?: boolean;
}

async function resolveBody(opts: CommentOpts): Promise<string> {
  const providedCount = [opts.body, opts.bodyFile, opts.stdin].filter(Boolean).length;
  if (providedCount === 0) {
    if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
    throw new Error("no body — pass --body, --body-file, or pipe to stdin");
  }
  if (providedCount > 1) {
    throw new Error("pick one of --body / --body-file / --stdin");
  }
  if (opts.body) return opts.body;
  if (opts.bodyFile) return (await Bun.file(opts.bodyFile).text()).trim();
  return (await Bun.stdin.text()).trim();
}
