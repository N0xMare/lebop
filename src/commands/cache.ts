import chalk from "chalk";
import type { Command } from "commander";
import { type GcCandidate, type GcResult, gcCache } from "../lib/cache.ts";
import { parseCliNumber } from "../lib/cliOptions.ts";
import { envelope } from "../lib/envelope.ts";
import { ValidationError } from "../lib/errors.ts";
import { statusAction } from "./status.ts";

interface CacheGcOpts {
  maxAge?: string;
  maxSize?: string;
  hash?: string;
  dryRun?: boolean; // commander auto-fills `dryRun` from `--no-dry-run`
  preserveCwd?: boolean; // commander auto-fills `preserveCwd` from `--no-preserve-cwd`
  yes?: boolean;
  json?: boolean;
}

function parsePositiveNumber(label: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return parseCliNumber(raw, { optionName: label });
}

function reasonStyle(reason: GcCandidate["reason"]): string {
  switch (reason) {
    case "age":
      return chalk.yellow("age");
    case "size":
      return chalk.magenta("size");
    case "explicit":
      return chalk.cyan("explicit");
  }
}

function printHuman(result: GcResult, dryRun: boolean): void {
  if (result.candidates.length === 0) {
    process.stdout.write(
      `${chalk.gray("no candidates — cache is")} ` +
        `${chalk.bold(`${result.totalSizeBeforeMb} MB`)}` +
        `${chalk.gray(" across all repos.")}\n`,
    );
    return;
  }

  // Column widths.
  const hashW = Math.max(4, ...result.candidates.map((c) => c.hash.length));
  const reasonW = Math.max(6, ...result.candidates.map((c) => c.reason.length));
  const sizeW = Math.max(7, ...result.candidates.map((c) => `${c.sizeMb} MB`.length));

  const header =
    `${chalk.bold("HASH".padEnd(hashW))}  ` +
    `${chalk.bold("REASON".padEnd(reasonW))}  ` +
    `${chalk.bold("SIZE".padStart(sizeW))}  ` +
    `${chalk.bold("LAST MODIFIED")}`;
  process.stdout.write(`${header}\n`);

  for (const c of result.candidates) {
    process.stdout.write(
      `${c.hash.padEnd(hashW)}  ` +
        `${reasonStyle(c.reason).padEnd(reasonW + (reasonStyle(c.reason).length - c.reason.length))}  ` +
        `${chalk.gray(`${c.sizeMb} MB`.padStart(sizeW))}  ` +
        `${chalk.gray(c.lastModified)}\n`,
    );
  }

  const total = result.candidates.length;
  const totalSizeMb = result.candidates.reduce((acc, c) => acc + c.sizeMb, 0);
  const summary = `${chalk.bold(total)} candidate${total === 1 ? "" : "s"}, ${chalk.bold(`${Math.round(totalSizeMb * 100) / 100} MB`)} total`;
  process.stdout.write(`\n${summary}\n`);

  if (dryRun) {
    process.stdout.write(
      `${chalk.cyan("dry run")} — pass ${chalk.bold("--no-dry-run")} to actually delete\n`,
    );
  } else {
    process.stdout.write(
      `${chalk.green("removed")} ${result.removed.length} hash${result.removed.length === 1 ? "" : "es"}. ` +
        `cache: ${result.totalSizeBeforeMb} MB → ${chalk.bold(`${result.totalSizeAfterMb} MB`)}\n`,
    );
  }
}

export function registerCache(program: Command): void {
  const cache = program.command("cache").description("inspect and maintain lebop's local cache");

  // `lebop cache status` — alias for top-level `lebop status`. Closes the
  // discoverability asymmetry where the MCP path exposes `cache_status` but
  // the CLI only had a top-level command. Same options, same behavior.
  cache
    .command("status")
    .description(
      "git-like status for the current repo's lebop cache (alias of top-level `lebop status`)",
    )
    .option("--team <key>", "override the resolved team")
    .option("--no-remote", "skip the remote-staleness check (faster, no Linear API calls)")
    .option("--json", "emit structured status")
    .action(statusAction);

  cache
    .command("gc")
    .description("garbage-collect stale per-repo cache directories under ~/.lebop/cache/")
    .option("--max-age <days>", "evict repos whose newest file is older than N days (default 30)")
    .option(
      "--max-size <MB>",
      "trim oldest repos until total cache size is below the limit (default 500)",
    )
    .option("--hash <H>", "evict only the named hash (skips age/size selection)")
    .option(
      "--no-dry-run",
      "actually delete (default is dry-run: report candidates without removing)",
    )
    .option(
      "--no-preserve-cwd",
      "allow eviction of the current repo's cache (default preserves it)",
    )
    .option("--yes", "confirm deletion when --no-dry-run is set")
    .option("--json", "emit structured result")
    .action(async (opts: CacheGcOpts) => {
      const maxAgeDays = parsePositiveNumber("--max-age", opts.maxAge);
      const maxSizeMb = parsePositiveNumber("--max-size", opts.maxSize);
      const dryRun = opts.dryRun !== false; // default true; --no-dry-run flips to false
      const preserveCwdRepo = opts.preserveCwd !== false; // default true
      if (!dryRun && opts.yes !== true) {
        throw new ValidationError(
          "cache gc deletion requires --yes",
          "run without --no-dry-run to preview, or pass --no-dry-run --yes to confirm deletion",
        );
      }

      const result = await gcCache({
        maxAgeDays,
        maxSizeMb,
        hash: opts.hash,
        dryRun,
        preserveCwdRepo,
      });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ dry_run: dryRun, ...result }), null, 2)}\n`,
        );
        return;
      }

      printHuman(result, dryRun);
    });
}
