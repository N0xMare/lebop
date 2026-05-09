import chalk from "chalk";
import type { Command } from "commander";
import { rewriteNotFound } from "../lib/errors.ts";
import { withClient } from "../lib/sdk.ts";

const ATTACH_URL_MUTATION = /* GraphQL */ `
  mutation AttachLinkURL($input: AttachmentLinkUrlInput!) {
    attachmentLinkURL(input: $input) {
      success
      attachment { id title url }
    }
  }
`;

const SIMPLE_ATTACH_URL_MUTATION = /* GraphQL */ `
  mutation AttachURL($issueId: String!, $url: String!, $title: String!) {
    attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
      success
      attachment { id title url }
    }
  }
`;

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
      // Resolve issue identifier → UUID via withClient (idempotent read).
      const fetched = await withClient((c) => c.issue(upperId));
      if (!fetched) throw new Error(`issue not found: ${upperId}`);

      const title = opts.title ?? url;
      try {
        // Linear's attachmentLinkURL takes positional-style args.
        const response = (await withClient((c) =>
          c.client.rawRequest(SIMPLE_ATTACH_URL_MUTATION, {
            issueId: fetched.id,
            url,
            title,
          }),
        )) as {
          data: {
            attachmentLinkURL: {
              success: boolean;
              attachment: { id: string; title: string; url: string };
            };
          };
        };
        const attachment = response.data.attachmentLinkURL.attachment;

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                schema_version: 1,
                issue: upperId,
                attachment,
              },
              null,
              2,
            )}\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} linked ${chalk.bold(upperId)} → ${chalk.cyan(attachment.title)} ${chalk.gray(`(${attachment.id})`)}\n${chalk.gray(attachment.url)}\n`,
        );
      } catch (err) {
        throw rewriteNotFound(err, upperId);
      }
    });
}

// Suppress unused warning for the input-shape mutation we don't currently
// use. Kept as a reference for the alternate API shape Linear also accepts.
void ATTACH_URL_MUTATION;
