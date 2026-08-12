import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { NotFoundError } from "../lib/errors.ts";
import { showNext } from "../lib/nextStubs.ts";
import { addMachineOutputOptions, writeMachineEnvelope } from "../lib/output.ts";
import { isUuid } from "../lib/uuid.ts";
import {
  buildIssueGetInputFromCli,
  executeIssueGet,
  type IssueContext,
} from "../surface/issues.ts";

export function registerShow(program: Command): void {
  const cmd = program
    .command("show <id>")
    .description(
      "fetch and print an issue shell — dense by default (no comments). use --comments or pull to edit.",
    )
    .option("--comments", "include comments (off by default in 0.0.6)")
    .option("--no-relations", "omit relation summary")
    .option("--full-content", "return full description on the wire (bypass 64 KiB agent size cap)")
    .option(
      "--content-file <path>",
      "write full description to path; wire stays dense (prefer for large bodies)",
    );
  addMachineOutputOptions(cmd);
  cmd.action(
    async (
      id: string,
      opts: {
        comments?: boolean;
        relations?: boolean;
        fullContent?: boolean;
        contentFile?: string;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      },
    ) => {
      // Round-6 / CLI 17: accept UUIDs (lowercase hex) without mangling
      // them via toUpperCase. TEAM-NN identifiers continue to upper-case
      // so `lebop show ue-359` keeps working.
      const idLooksUuid = isUuid(id);
      const upperId = idLooksUuid ? id : id.toUpperCase();
      // Maintainer --human: full bodies. Agents use machine path + content flags.
      const getOpts = wantsMachineOutput(opts) ? opts : { ...opts, fullContent: true };
      const result = await executeIssueGet(buildIssueGetInputFromCli({ id, opts: getOpts }));
      if (!result) throw new NotFoundError(`not found: ${upperId}`);

      if (wantsMachineOutput(opts)) {
        const truncated = result.content?.description_truncated === true;
        writeMachineEnvelope(
          {
            issue: result,
            ...(result.content ? { content: result.content } : {}),
            next: showNext({
              includeComments: Boolean(opts.comments),
              truncated,
              identifier: result.metadata.identifier,
            }),
          },
          { json: true, format: opts.format, pretty: opts.pretty, shape: "nested" },
        );
        return;
      }

      printHuman(result);
    },
  );
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
  if (issue.content?.content_file) {
    process.stdout.write(
      `${chalk.gray("content_file:")} ${issue.content.content_file} (${issue.content.content_bytes ?? "?"} bytes)\n`,
    );
  }
  if (issue.content?.description_truncated) {
    process.stdout.write(
      `${chalk.yellow("note:")} description truncated (${issue.content.description_original_bytes} > ${issue.content.description_limit_bytes} bytes); re-run with --content-file or --full-content\n`,
    );
  }

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
