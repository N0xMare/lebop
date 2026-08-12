import chalk from "chalk";
import type { Command } from "commander";
import { findGitRoot, hashRepoRoot } from "../lib/config.ts";
import { wantsMachineOutput } from "../lib/encode.ts";
import { bulkNext } from "../lib/nextStubs.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import { buildIssueBulkUpdateInputFromCli, executeIssueBulkUpdate } from "../surface/issues.ts";

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
    .option("--dry-run", "resolve and preview the batch update without mutating Linear")
    .option("--yes", "confirm the batch update")
    .option("--confirm", "alias for --yes")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
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
          dryRun?: boolean;
          yes?: boolean;
          confirm?: boolean;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const repoRoot = findGitRoot(process.cwd());
        const result = await executeIssueBulkUpdate(
          buildIssueBulkUpdateInputFromCli({
            identifiers,
            opts,
            repoHash: repoRoot ? hashRepoRoot(repoRoot) : "_global",
            repoRoot,
          }),
        );
        if (result.summary.failed > 0 || result.cache.failed > 0) process.exitCode = 1;

        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            {
              results: result.results,
              summary: result.summary,
              cache: result.cache,
              next: bulkNext(),
            },
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
          return;
        }

        for (const row of result.results) {
          if (row.status === "updated") {
            process.stdout.write(
              `${chalk.green("✓")} ${chalk.bold(row.identifier)}  ${chalk.gray((row.fields ?? []).join(", "))}\n`,
            );
          } else if (row.status === "would_update") {
            process.stdout.write(
              `${chalk.yellow("dry-run")} ${chalk.bold(row.identifier)}  ${chalk.gray((row.fields ?? []).join(", "))}\n`,
            );
          } else {
            process.stdout.write(
              `${chalk.red("✗")} ${chalk.bold(row.identifier)}  ${chalk.red(row.error?.code ?? "error")}: ${row.error?.message ?? ""}\n`,
            );
          }
        }
        process.stdout.write(
          `\n${chalk.bold(`${result.summary.updated}/${result.summary.total}`)} updated${
            result.summary.would_update > 0
              ? chalk.yellow(` (${result.summary.would_update} would update)`)
              : ""
          }${result.summary.failed > 0 ? chalk.red(` (${result.summary.failed} failed)`) : ""}\n`,
        );
        if (result.cache.failed > 0) {
          process.stdout.write(
            `${chalk.yellow("cache:")} ${result.cache.failed} updated row(s) could not be refreshed; run \`lebop pull <id> --refresh --yes\` before relying on local cache, after verifying overwrite is intended.\n`,
          );
        }
      },
    );
}
