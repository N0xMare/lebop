import chalk from "chalk";
import type { Command } from "commander";
import type { CachePushResult } from "../lib/cachePush.ts";
import { envelope } from "../lib/envelope.ts";
import {
  buildCachePushInputFromCli,
  cachePushPayload,
  executeCachePush,
} from "../surface/cache.ts";

interface PushOpts {
  team?: string;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
  confirm?: boolean;
  strict?: boolean;
  projectId?: string[];
  json?: boolean;
}

export function registerPush(program: Command): void {
  program
    .command("push [ids...]")
    .description("push locally-modified cache entries back to Linear")
    .option("--team <key>", "override the resolved team")
    .option("--dry-run", "print diff and mutations; no API calls")
    .option("--force", "skip updatedAt staleness check (dangerous)")
    .option("--yes", "confirm --force when applying mutations")
    .option("--confirm", "alias for --yes")
    .option("--strict", "block push on any lint warning")
    .option(
      "--project-id <uuid>",
      "push a specific modified cached project; repeatable",
      collect,
      [],
    )
    .option("--json", "emit structured per-entity result records")
    .action(async (ids: string[], opts: PushOpts) => {
      const result = await executeCachePush(buildCachePushInputFromCli({ ids, opts }));
      const dryRun = result.dryRun;

      if (result.results.length === 0) {
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              envelope({
                team: result.team,
                repo_hash: result.repoHash,
                mode: "cache" as const,
                results: [],
                summary: { applied: 0, skipped: 0, failed: 0, total: 0 },
                notes: dryRun ? "dry-run: nothing was written" : undefined,
              }),
              null,
              2,
            )}\n`,
          );
        } else {
          process.stdout.write("nothing to push — cache is clean\n");
        }
        return;
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(cachePushPayload(result)), null, 2)}\n`);
      } else {
        printSummary(result.results, dryRun);
      }

      if (result.summary.failed > 0 || (result.summary.writeback_failed ?? 0) > 0) {
        process.exitCode = 1;
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function printSummary(results: CachePushResult[], dryRun: boolean): void {
  for (const r of results) {
    const label = `${r.kind === "issue" ? r.target : `project/${r.target}`}`;
    if (r.status === "pushed") {
      process.stdout.write(
        `${chalk.green("✓")} ${label}  ${chalk.gray(r.fields?.join(", ") ?? "")}\n`,
      );
    } else if (r.status === "pushed-writeback-failed") {
      process.stdout.write(`${chalk.red("✗")} ${label}  ${r.error}\n`);
    } else if (r.status === "dry-run") {
      process.stdout.write(
        `${chalk.cyan("dry-run")} ${label}  ${chalk.gray(r.fields?.join(", ") ?? "")}\n`,
      );
    } else if (r.status === "unchanged") {
      process.stdout.write(`${chalk.gray("·")} ${label}  unchanged\n`);
    } else if (r.status === "stale") {
      process.stdout.write(`${chalk.yellow("!")} ${label}  stale: ${r.error}\n`);
    } else if (r.status === "remote-missing") {
      process.stdout.write(`${chalk.red("✗")} ${label}  ${r.error}\n`);
    } else if (r.status === "lint-blocked") {
      process.stdout.write(`${chalk.red("✗")} ${label}  ${r.error}\n`);
    } else if (r.status === "error") {
      process.stdout.write(`${chalk.red("✗")} ${label}  ${r.error}\n`);
    }
  }
  if (dryRun) {
    const count = results.filter((r) => r.status === "dry-run").length;
    process.stdout.write(
      chalk.gray(`\n${count} mutation(s) planned — rerun without --dry-run to apply\n`),
    );
  }
}
