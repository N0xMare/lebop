import chalk from "chalk";
import type { Command } from "commander";
import { listAttachments } from "../lib/attachments.ts";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError, rewriteNotFound } from "../lib/errors.ts";
import { withClient } from "../lib/sdk.ts";

const ATTACH_URL_MUTATION = /* GraphQL */ `
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
      if (!fetched) throw new NotFoundError(`issue not found: ${upperId}`);

      const title = opts.title ?? url;
      // Round-6 / H8: `lebop link` is now idempotent. Linear's
      // `attachmentLinkURL` enforces (issueId, url) uniqueness server-side
      // and throws "URL has already been linked" on the second call.
      // Pre-fix that surfaced as exit 1, which broke scripts that re-run
      // `lebop link` defensively. Post-fix: detect that error, look up the
      // existing attachment via listAttachments, and return it with a
      // `status: "already-linked"` marker so callers can distinguish.
      let attachment: { id: string; title: string; url: string };
      let status: "linked" | "already-linked" = "linked";
      try {
        const response = (await withClient((c) =>
          c.client.rawRequest(ATTACH_URL_MUTATION, {
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
        attachment = response.data.attachmentLinkURL.attachment;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Round-8 / R6-LOW-1: dropped redundant first regex; second regex
        // (`/already.*linked/i`) is a strict superset.
        if (/already.*linked/i.test(msg)) {
          // Idempotent path: find the existing attachment and surface it
          // with the same envelope shape. listAttachments is workspace-wide
          // for the issue, so we filter by URL equality.
          const existing = await listAttachments(upperId);
          const match = existing.find((a) => a.url === url);
          if (!match) {
            // Server says it's linked but we can't find it — surface the
            // original error rather than silently swallowing.
            throw rewriteNotFound(err, upperId);
          }
          attachment = { id: match.id, title: match.title, url: match.url };
          status = "already-linked";
        } else {
          throw rewriteNotFound(err, upperId);
        }
      }

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
