import chalk from "chalk";
import type { Command } from "commander";
import { linkUrlAttachment } from "../lib/attachments.ts";
import { envelope } from "../lib/envelope.ts";

/**
 * `lebop link <issue> <url> [--title]` — attach a URL to a Linear issue
 * (creates an Attachment with the URL as its target). Common use: link
 * a PR, design doc, or external bug tracker.
 *
 * Linear's API: `attachmentLinkURL(issueId, url, title)` — argument-based,
 * not input-shape. Returns the created Attachment.
 */
export function registerLink(program: Command): void {
  program
    .command("link <issue> <url>")
    .description("attach a URL to an issue (link a PR, doc, etc.)")
    .option("--title <text>", "display title (defaults to the URL)")
    .option("--json", "emit structured result")
    .action(async (issue: string, url: string, opts: { title?: string; json?: boolean }) => {
      const upperId = issue.toUpperCase();
      const { attachment, status } = await linkUrlAttachment(upperId, url, opts.title ?? url);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              issue: upperId,
              attachment,
              status,
            }),
            null,
            2,
          )}\n`,
        );
        return;
      }
      const verb = status === "already-linked" ? "already linked" : "linked";
      const icon = status === "already-linked" ? chalk.gray("✓") : chalk.green("✓");
      process.stdout.write(
        `${icon} ${verb} ${chalk.bold(upperId)} → ${chalk.cyan(attachment.title)} ${chalk.gray(`(${attachment.id})`)}\n${chalk.gray(attachment.url)}\n`,
      );
    });
}
