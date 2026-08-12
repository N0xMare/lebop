import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { attachmentNext } from "../lib/nextStubs.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
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
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(async (issue: string, opts: { json?: boolean; format?: string; pretty?: boolean }) => {
      const result = await executeAttachmentList(buildAttachmentListInputFromCli({ issue }));
      if (wantsMachineOutput(opts)) {
        writeMachineEnvelope(
          { ...result, next: attachmentNext("list") } as Record<string, unknown>,
          {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          },
        );
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
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        id: string,
        opts: { title?: string; url?: string; json?: boolean; format?: string; pretty?: boolean },
      ) => {
        const { attachment } = await executeAttachmentUpdate(
          buildAttachmentUpdateInputFromCli({ id, opts }),
        );
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            { attachment, next: attachmentNext("update") } as Record<string, unknown>,
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated ${chalk.bold(attachment.title)} ${chalk.gray(`(${attachment.id})`)}\n`,
        );
      },
    );

  cmd
    .command("upload <issue> <file>")
    .description("upload a local file and attach it to an issue (Linear fileUpload)")
    .option("--title <text>", "attachment title (default: filename)")
    .option("--content-type <mime>", "override content type")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        issue: string,
        file: string,
        opts: {
          title?: string;
          contentType?: string;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const { createFileAttachment } = await import("../lib/attachments.ts");
        const result = await createFileAttachment({
          identifier: issue,
          filePath: file,
          title: opts.title,
          contentType: opts.contentType,
        });
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(result as unknown as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} uploaded ${chalk.bold(result.attachment.title)} → ${result.issue}\n`,
        );
      },
    );

  cmd
    .command("delete <id>")
    .description("delete an attachment by UUID (irreversible — requires --yes)")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        id: string,
        opts: { yes?: boolean; json?: boolean; format?: string; pretty?: boolean },
      ) => {
        // Round-7 / CLI smoke #5: gate behind --yes (parity with every other
        // destructive delete) and adopt tryIdempotentDelete for status field
        // parity. Pre-fix this was the only delete command without --yes.
        // Round-8 / N2 + N5: status/success discrimination + exitCode on
        // deleted+!success stays in execute + thin adapter.
        const r = await executeAttachmentDelete(buildAttachmentDeleteInputFromCli({ id, opts }));
        if (r.status === "deleted" && !r.success) process.exitCode = 1;
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            {
              id: r.id,
              status: r.status,
              success: r.success,
              next: attachmentNext("delete"),
            } as Record<string, unknown>,
            { json: true, format: opts.format, pretty: opts.pretty },
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
      },
    );
}
