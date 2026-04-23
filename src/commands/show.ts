import chalk from "chalk";
import type { Command } from "commander";
import { buildComments, buildIssueMetadata } from "../lib/build.ts";
import { type FetchedIssue, buildPullIssuesQuery } from "../lib/pullQuery.ts";
import { linear } from "../lib/sdk.ts";

export function registerShow(program: Command): void {
  program
    .command("show <id>")
    .description(
      "fetch and print an issue inline — no cache side-effect. use `pull` when you want to edit and push back.",
    )
    .option("--no-comments", "skip comments for a terser output")
    .option("--json", "emit structured JSON instead of formatted output")
    .action(async (id: string, opts: { comments?: boolean; json?: boolean }) => {
      const withComments = opts.comments !== false;
      const query = buildPullIssuesQuery([id.toUpperCase()], withComments, true);
      const client = await linear();
      const response = (await client.client.rawRequest(query)) as {
        data: Record<string, FetchedIssue | null>;
      };
      const node = response.data.a0;
      if (!node) {
        process.stderr.write(`${chalk.red("not found:")} ${id}\n`);
        process.exit(1);
      }

      if (opts.json) {
        const { metadata, description } = buildIssueMetadata(node);
        const commentList = withComments ? buildComments(node) : [];
        const relations = buildRelationSummary(node);
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              metadata,
              description,
              comments: commentList,
              relations,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      printHuman(node);
    });
}

function printHuman(issue: FetchedIssue): void {
  const priorityName =
    ["none", "urgent", "high", "normal", "low"][issue.priority] ?? `p${issue.priority}`;
  const assignee = issue.assignee ? `@${issue.assignee.email}` : "unassigned";

  process.stdout.write(
    `${chalk.bold(issue.identifier)} ${chalk.gray("•")} ${chalk.cyan(`[${issue.state.name}]`)} ${chalk.gray("•")} ${chalk.yellow(priorityName)} ${chalk.gray("•")} ${assignee}\n`,
  );
  process.stdout.write(`${chalk.bold(issue.title)}\n\n`);

  const labels = issue.labels.nodes.map((l) => l.name).join(", ") || "(none)";
  process.stdout.write(`${chalk.gray("labels:")}  ${labels}\n`);
  if (issue.project) {
    process.stdout.write(`${chalk.gray("project:")} ${issue.project.name}\n`);
  }
  process.stdout.write(`${chalk.gray("updated:")} ${issue.updatedAt}\n`);
  process.stdout.write(`${chalk.gray("url:")}     ${issue.url}\n`);

  const description = issue.description ?? "";
  if (description.trim()) {
    process.stdout.write(`\n${chalk.gray("── description ──")}\n\n${description}\n`);
  } else {
    process.stdout.write(`\n${chalk.gray("(no description)")}\n`);
  }

  const outbound = issue.relations?.nodes ?? [];
  const inbound = issue.inverseRelations?.nodes ?? [];
  if (outbound.length > 0 || inbound.length > 0) {
    process.stdout.write(`\n${chalk.gray("── links ──")}\n`);
    for (const r of outbound) {
      process.stdout.write(
        `${chalk.gray("→")} ${chalk.cyan(r.type)} ${chalk.bold(r.relatedIssue.identifier)} ${chalk.gray(r.relatedIssue.title)}\n`,
      );
    }
    for (const r of inbound) {
      process.stdout.write(
        `${chalk.gray("←")} ${chalk.cyan(r.type)} ${chalk.bold(r.issue.identifier)} ${chalk.gray(r.issue.title)}\n`,
      );
    }
  }

  const comments = issue.comments?.nodes ?? [];
  if (comments.length > 0) {
    process.stdout.write(`\n${chalk.gray(`── comments (${comments.length}) ──`)}\n`);
    for (const c of comments) {
      const who = c.user ? `${c.user.name} <${c.user.email}>` : "unknown";
      process.stdout.write(`\n${chalk.dim(c.createdAt)}  ${chalk.bold(who)}\n${c.body}\n`);
    }
  }
}

function buildRelationSummary(issue: FetchedIssue): {
  outbound: { id: string; type: string; identifier: string; title: string }[];
  inbound: { id: string; type: string; identifier: string; title: string }[];
} {
  return {
    outbound: (issue.relations?.nodes ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      identifier: r.relatedIssue.identifier,
      title: r.relatedIssue.title,
    })),
    inbound: (issue.inverseRelations?.nodes ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      identifier: r.issue.identifier,
      title: r.issue.title,
    })),
  };
}
