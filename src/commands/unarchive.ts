import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { expandIds } from "../lib/expand.ts";
import { type LifecycleResult, unarchiveIssues } from "../lib/issues.ts";

interface UnarchiveOpts {
  json?: boolean;
}

export function registerUnarchive(program: Command): void {
  program
    .command("unarchive <ids...>")
    .description("unarchive one or more issues (reverse of `archive`)")
    .option("--json", "emit structured results")
    .action(async (ids: string[], opts: UnarchiveOpts) => {
      const identifiers = expandIds(ids);

      // Wave-3 parity: delegate to the lib's unarchiveIssues so the CLI and
      // MCP emit the same per-row status enum (`"ok"` instead of CLI-only
      // `"unarchived"`).
      const results = await unarchiveIssues(identifiers);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ results }), null, 2)}\n`);
      } else {
        for (const r of results) {
          process.stdout.write(`${renderHumanLine(r)}\n`);
        }
      }

      if (results.some((r) => r.status === "error" || r.status === "not-found")) {
        process.exitCode = 1;
      }
    });
}

function renderHumanLine(r: LifecycleResult): string {
  if (r.status === "ok") {
    return `${chalk.green("✓")} ${chalk.bold(r.identifier)} ${chalk.gray("unarchived")}`;
  }
  if (r.status === "not-found") {
    return `${chalk.yellow("?")} ${chalk.bold(r.identifier)} ${chalk.yellow("not found")}`;
  }
  return `${chalk.red("✗")} ${chalk.bold(r.identifier)} ${chalk.red(r.error ?? "error")}`;
}
