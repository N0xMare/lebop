import chalk from "chalk";
import type { Command } from "commander";
import { bulkUpdateIssues } from "../lib/bulk.ts";
import { envelope } from "../lib/envelope.ts";

/**
 * `lebop bulk update <identifiers...>` — apply one patch to N issues. Wraps
 * the lib's `bulkUpdateIssues`. Emits the same partial-success envelope as
 * the MCP tool when `--json` is passed; in human mode prints a compact
 * per-row summary + a totals line.
 */
export function registerBulk(program: Command): void {
  const cmd = program.command("bulk").description("bulk operations across many entities");

  cmd
    .command("update <identifiers...>")
    .description("apply one patch to N issues (TEAM-NN). uses Linear's issueBatchUpdate")
    .option("--state <name>")
    .option("--priority <value>", "urgent|high|normal|low|none or 0..4")
    .option("--label <name...>", "replaces the full label set (repeatable)")
    .option("--assignee <who>", "'@me' | email | name | 'null' to clear")
    .option("--estimate <n>", "number, or 'null' to clear")
    .option("--project <name-or-uuid-or-null>")
    .option("--milestone <name-or-uuid-or-null>")
    .option("--cycle <name-or-uuid-or-null>")
    .option("--team <key>", "override the team derived from identifier prefixes")
    .option("--json", "emit the per-row result envelope")
    .action(
      async (
        identifiers: string[],
        opts: {
          state?: string;
          priority?: string;
          label?: string[];
          assignee?: string;
          estimate?: string;
          project?: string;
          milestone?: string;
          cycle?: string;
          team?: string;
          json?: boolean;
        },
      ) => {
        const patch: Parameters<typeof bulkUpdateIssues>[0]["patch"] = {};
        if (opts.state !== undefined) patch.state = opts.state;
        if (opts.priority !== undefined) patch.priority = opts.priority;
        if (opts.label !== undefined) patch.labels = opts.label;
        if (opts.assignee !== undefined) {
          patch.assignee = opts.assignee === "null" ? null : opts.assignee;
        }
        if (opts.estimate !== undefined) {
          patch.estimate = opts.estimate === "null" ? null : Number.parseFloat(opts.estimate);
        }
        if (opts.project !== undefined) {
          patch.project = opts.project === "null" ? null : opts.project;
        }
        if (opts.milestone !== undefined) {
          patch.milestone = opts.milestone === "null" ? null : opts.milestone;
        }
        if (opts.cycle !== undefined) {
          patch.cycle = opts.cycle === "null" ? null : opts.cycle;
        }

        const result = await bulkUpdateIssues({
          identifiers,
          patch,
          team: opts.team,
        });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope({ results: result.results, summary: result.summary }), null, 2)}\n`,
          );
          return;
        }

        for (const row of result.results) {
          if (row.status === "updated") {
            process.stdout.write(
              `${chalk.green("✓")} ${chalk.bold(row.identifier)}  ${chalk.gray((row.fields ?? []).join(", "))}\n`,
            );
          } else {
            process.stdout.write(
              `${chalk.red("✗")} ${chalk.bold(row.identifier)}  ${chalk.red(row.error?.code ?? "error")}: ${row.error?.message ?? ""}\n`,
            );
          }
        }
        process.stdout.write(
          `\n${chalk.bold(`${result.summary.updated}/${result.summary.total}`)} updated${
            result.summary.failed > 0 ? chalk.red(` (${result.summary.failed} failed)`) : ""
          }\n`,
        );
        if (result.summary.failed > 0) process.exitCode = 1;
      },
    );
}
