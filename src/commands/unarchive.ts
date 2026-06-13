import chalk from "chalk";
import type { Command } from "commander";
import { findGitRoot, hashRepoRoot } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import type { LifecycleResult } from "../lib/issues.ts";
import { buildIssueUnarchiveInputFromCli, executeIssueUnarchive } from "../surface/issues.ts";

interface UnarchiveOpts {
  json?: boolean;
}

export function registerUnarchive(program: Command): void {
  program
    .command("unarchive <ids...>")
    .description("unarchive one or more issues (reverse of `archive`)")
    .option("--json", "emit structured results")
    .action(async (ids: string[], opts: UnarchiveOpts) => {
      // Wave-3 parity: delegate to the lib's unarchiveIssues so the CLI and
      // MCP emit the same per-row status enum (`"ok"` instead of CLI-only
      // `"unarchived"`).
      const { results, cache } = await executeIssueUnarchive(
        buildIssueUnarchiveInputFromCli({ identifiers: ids }),
        CLI_ISSUE_CACHE_DEPS,
      );

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ results, cache }), null, 2)}\n`);
      } else {
        for (const r of results) {
          process.stdout.write(`${renderHumanLine(r)}\n`);
        }
        if (cache.failed > 0) {
          process.stdout.write(
            `${chalk.yellow("cache:")} ${cache.failed} unarchived row(s) could not be refreshed; run \`lebop pull <id> --refresh --yes\` before relying on local cache, after verifying overwrite is intended.\n`,
          );
        }
      }

      if (
        results.some((r) => r.status === "error" || r.status === "not-found") ||
        cache.failed > 0
      ) {
        process.exitCode = 1;
      }
    });
}

const CLI_ISSUE_CACHE_DEPS = {
  resolveCacheContext: () => {
    const repoRoot = findGitRoot(process.cwd());
    return { repoRoot, repoHash: repoRoot ? hashRepoRoot(repoRoot) : "_global" };
  },
};

function renderHumanLine(r: LifecycleResult): string {
  if (r.status === "ok") {
    return `${chalk.green("✓")} ${chalk.bold(r.identifier)} ${chalk.gray("unarchived")}`;
  }
  if (r.status === "not-found") {
    return `${chalk.yellow("?")} ${chalk.bold(r.identifier)} ${chalk.yellow("not found")}`;
  }
  return `${chalk.red("✗")} ${chalk.bold(r.identifier)} ${chalk.red(r.error ?? "error")}`;
}
