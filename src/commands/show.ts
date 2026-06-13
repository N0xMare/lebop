import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError } from "../lib/errors.ts";
import { isUuid } from "../lib/uuid.ts";
import {
  buildIssueGetInputFromCli,
  executeIssueGet,
  type IssueContext,
} from "../surface/issues.ts";

export function registerShow(program: Command): void {
  program
    .command("show <id>")
    .description(
      "fetch and print an issue inline — no cache side-effect. use `pull` when you want to edit and push back.",
    )
    .option("--no-comments", "skip comments for a terser output")
    .option("--json", "emit structured JSON instead of formatted output")
    .action(async (id: string, opts: { comments?: boolean; json?: boolean }) => {
      // Round-6 / CLI 17: accept UUIDs (lowercase hex) without mangling
      // them via toUpperCase. TEAM-NN identifiers continue to upper-case
      // so `lebop show ue-359` keeps working.
      const idLooksUuid = isUuid(id);
      const upperId = idLooksUuid ? id : id.toUpperCase();
      const result = await executeIssueGet(buildIssueGetInputFromCli({ id, opts }));
      if (!result) throw new NotFoundError(`not found: ${upperId}`);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ ...result }), null, 2)}\n`);
        return;
      }

      printHuman(result);
    });
}

function printHuman(issue: IssueContext): void {
  const metadata = issue.metadata;
  const server = metadata._server;
  const priorityName =
    ["none", "urgent", "high", "normal", "low"][metadata.priority] ?? `p${metadata.priority}`;
  const assignee = metadata.assignee ? `@${metadata.assignee}` : "unassigned";

  process.stdout.write(
    `${chalk.bold(metadata.identifier)} ${chalk.gray("•")} ${chalk.cyan(`[${metadata.state}]`)} ${chalk.gray("•")} ${chalk.yellow(priorityName)} ${chalk.gray("•")} ${assignee}\n`,
  );
  process.stdout.write(`${chalk.bold(metadata.title)}\n\n`);

  const labels = metadata.labels.join(", ") || "(none)";
  process.stdout.write(`${chalk.gray("labels:")}  ${labels}\n`);
  if (metadata.project) {
    process.stdout.write(`${chalk.gray("project:")} ${metadata.project}\n`);
  }
  process.stdout.write(`${chalk.gray("updated:")} ${server.updated_at}\n`);
  process.stdout.write(`${chalk.gray("url:")}     ${server.url}\n`);

  if (issue.description.trim()) {
    process.stdout.write(`\n${chalk.gray("── description ──")}\n\n${issue.description}\n`);
  } else {
    process.stdout.write(`\n${chalk.gray("(no description)")}\n`);
  }

  const outbound = issue.relations?.outbound ?? [];
  const inbound = issue.relations?.inbound ?? [];
  if (outbound.length > 0 || inbound.length > 0) {
    process.stdout.write(`\n${chalk.gray("── links ──")}\n`);
    for (const r of outbound) {
      process.stdout.write(
        `${chalk.gray("→")} ${chalk.cyan(r.type)} ${chalk.bold(r.identifier)} ${chalk.gray(r.title)}\n`,
      );
    }
    for (const r of inbound) {
      process.stdout.write(
        `${chalk.gray("←")} ${chalk.cyan(r.type)} ${chalk.bold(r.identifier)} ${chalk.gray(r.title)}\n`,
      );
    }
  }

  const comments = issue.comments ?? [];
  if (comments.length > 0) {
    process.stdout.write(`\n${chalk.gray(`── comments (${comments.length}) ──`)}\n`);
    for (const c of comments) {
      const who = `${c.frontmatter.author_name} <${c.frontmatter.author}>`;
      process.stdout.write(
        `\n${chalk.dim(c.frontmatter.created_at)}  ${chalk.bold(who)}\n${c.body}\n`,
      );
    }
  }
}
