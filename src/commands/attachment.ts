import chalk from "chalk";
import type { Command } from "commander";
import { deleteAttachment, listAttachments, updateAttachment } from "../lib/attachments.ts";
import { envelope } from "../lib/envelope.ts";
import { tryIdempotentDelete } from "../lib/errors.ts";

/**
 * `lebop attachment list|update|delete` — symmetric CRUD over Linear
 * Attachments. Pairs with `lebop link` (which creates URL attachments) so
 * the full lifecycle has a CLI surface.
 */
export function registerAttachment(program: Command): void {
  const cmd = program.command("attachment").description("manage Linear issue attachments");

  cmd
    .command("list <issue>")
    .description("list attachments on an issue (TEAM-NN)")
    .option("--json", "emit structured records")
    .action(async (issue: string, opts: { json?: boolean }) => {
      const upper = issue.toUpperCase();
      const attachments = await listAttachments(upper);
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({ identifier: upper, count: attachments.length, attachments }),
            null,
            2,
          )}\n`,
        );
        return;
      }
      if (attachments.length === 0) {
        process.stdout.write(`no attachments on ${upper}\n`);
        return;
      }
      for (const a of attachments) {
        process.stdout.write(`${chalk.bold(a.title)}\n  ${chalk.cyan(a.url)}\n`);
        process.stdout.write(`  ${chalk.gray(a.id)}\n`);
      }
    });

  cmd
    .command("update <id>")
    .description("update an attachment's title or URL")
    .option("--title <text>")
    .option("--url <url>")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { title?: string; url?: string; json?: boolean }) => {
      const input: { title?: string; url?: string } = {};
      if (opts.title !== undefined) input.title = opts.title;
      if (opts.url !== undefined) input.url = opts.url;
      if (Object.keys(input).length === 0) {
        process.stderr.write(`${chalk.red("nothing to update.")} pass --title or --url\n`);
        process.exitCode = 1;
        return;
      }
      const attachment = await updateAttachment(id, input);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ attachment }), null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `${chalk.green("✓")} updated ${chalk.bold(attachment.title)} ${chalk.gray(`(${attachment.id})`)}\n`,
      );
    });

  cmd
    .command("delete <id>")
    .description("delete an attachment by UUID (irreversible — requires --yes)")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      // Round-7 / CLI smoke #5: gate behind --yes (parity with every other
      // destructive delete) and adopt tryIdempotentDelete for status field
      // parity. Pre-fix this was the only delete command without --yes.
      if (!opts.yes) {
        process.stderr.write(
          `${chalk.red("error:")} refusing to delete attachment ${chalk.bold(id)} without --yes\n` +
            `  ${chalk.cyan("hint:")} re-run with --yes to confirm. This operation is irreversible.\n`,
        );
        process.exitCode = 1;
        return;
      }
      // Round-8 / N2: tryIdempotentDelete now returns a discriminated union
      // — `result.result` only exists on the "deleted" branch (typed as the
      // wrapped lib's return value). Narrow via `result.status`.
      // Round-8 / N5: ensure exitCode = 1 fires on the theoretical
      // `status === "deleted"` + `result.result === false` branch in JSON
      // mode too (Linear's attachmentDelete API contract: returns true or
      // throws, so this branch is defensive).
      const r = await tryIdempotentDelete(() => deleteAttachment(id));
      const succeeded = r.status === "deleted" && r.result;
      if (r.status === "deleted" && !r.result) process.exitCode = 1;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ id, status: r.status, success: succeeded }), null, 2)}\n`,
        );
        return;
      }
      if (r.status === "already-absent") {
        process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(id)} (no-op)\n`);
      } else if (r.result) {
        process.stdout.write(`${chalk.green("✓")} deleted attachment ${chalk.bold(id)}\n`);
      } else {
        process.stderr.write(`${chalk.red("✗")} delete failed for ${id}\n`);
      }
    });
}
