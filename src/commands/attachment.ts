import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import {
  buildAttachmentDeleteInputFromCli,
  buildAttachmentListInputFromCli,
  buildAttachmentUpdateInputFromCli,
  executeAttachmentDelete,
  executeAttachmentList,
  executeAttachmentUpdate,
} from "../surface/attachments.ts";

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
      const result = await executeAttachmentList(buildAttachmentListInputFromCli({ issue }));
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ ...result }), null, 2)}\n`);
        return;
      }
      if (result.attachments.length === 0) {
        process.stdout.write(`no attachments on ${result.identifier}\n`);
        return;
      }
      for (const a of result.attachments) {
        process.stdout.write(`${chalk.bold(a.title)}\n  ${chalk.cyan(a.url)}\n`);
        process.stdout.write(`  ${chalk.gray(a.id)}\n`);
      }
    });

  cmd
    .command("update <id>")
    .description("update an attachment's title; URL changes require delete + relink")
    .option("--title <text>")
    .option("--url <url>")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { title?: string; url?: string; json?: boolean }) => {
      const { attachment } = await executeAttachmentUpdate(
        buildAttachmentUpdateInputFromCli({ id, opts }),
      );
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
      // Round-8 / N2 + N5: status/success discrimination + exitCode on
      // deleted+!success stays in execute + thin adapter.
      const r = await executeAttachmentDelete(buildAttachmentDeleteInputFromCli({ id, opts }));
      if (r.status === "deleted" && !r.success) process.exitCode = 1;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ id: r.id, status: r.status, success: r.success }), null, 2)}\n`,
        );
        return;
      }
      if (r.status === "already-absent") {
        process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(id)} (no-op)\n`);
      } else if (r.success) {
        process.stdout.write(`${chalk.green("✓")} deleted attachment ${chalk.bold(id)}\n`);
      } else {
        process.stderr.write(`${chalk.red("✗")} delete failed for ${id}\n`);
      }
    });
}
