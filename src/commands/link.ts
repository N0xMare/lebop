import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { buildLinkUrlInputFromCli, executeLinkUrl, linkUrlCliPayload } from "../surface/link.ts";

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
      const result = await executeLinkUrl(buildLinkUrlInputFromCli({ issue, url, opts }));

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(linkUrlCliPayload(result)), null, 2)}\n`);
        return;
      }
      const verb = result.status === "already-linked" ? "already linked" : "linked";
      const icon = result.status === "already-linked" ? chalk.gray("✓") : chalk.green("✓");
      process.stdout.write(
        `${icon} ${verb} ${chalk.bold(result.identifier)} → ${chalk.cyan(result.attachment.title)} ${chalk.gray(`(${result.attachment.id})`)}\n${chalk.gray(result.attachment.url)}\n`,
      );
    });
}
