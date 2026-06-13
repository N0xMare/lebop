import chalk from "chalk";
import type { Command } from "commander";
import { findGitRoot, hashRepoRoot } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { ValidationError } from "../lib/errors.ts";
import type { LifecycleResult } from "../lib/issues.ts";
import { buildIssueArchiveInputFromCli, executeIssueArchive } from "../surface/issues.ts";

interface ArchiveOpts {
  json?: boolean;
  yes?: boolean;
  bulkFile?: string;
  bulkStdin?: boolean;
}

async function readBulkFile(path: string): Promise<string[]> {
  const text = await Bun.file(path).text();
  return parseIdentifierList(text);
}

async function readBulkStdin(): Promise<string[]> {
  return parseIdentifierList(await Bun.stdin.text());
}

/** Strip line comments + whitespace; return non-empty tokens. */
function parseIdentifierList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function registerArchive(program: Command): void {
  program
    .command("archive [ids...]")
    .description("archive one or more issues (reversible in Linear UI)")
    .option(
      "--bulk-file <path>",
      "read identifiers from a file (whitespace-separated, # comments OK)",
    )
    .option("--bulk-stdin", "read identifiers from stdin")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured results")
    .action(async (ids: string[], opts: ArchiveOpts) => {
      if (!opts.yes) {
        throw new ValidationError(
          "refusing to archive issues without --yes",
          "re-run with --yes to confirm this destructive state change",
        );
      }
      // Merge args + bulk inputs. Identifier sources combine; ranges
      // (TEAM-101..TEAM-105) are still expanded for any source.
      const fromFile = opts.bulkFile ? await readBulkFile(opts.bulkFile) : [];
      const fromStdin = opts.bulkStdin ? await readBulkStdin() : [];
      const allArgs = [...ids, ...fromFile, ...fromStdin];
      if (allArgs.length === 0) {
        throw new ValidationError(
          "no identifiers — pass them positionally or via --bulk-file / --bulk-stdin",
          "pass at least one issue identifier",
        );
      }
      const input = buildIssueArchiveInputFromCli({ identifiers: allArgs, opts });
      validateIdentifiers(input.identifiers);

      // Wave-3 parity: delegate to the lib's archiveIssues so the CLI and MCP
      // emit the same per-row status enum (`"ok"` instead of CLI-only
      // `"archived"`). The human renderer maps the lib enum back to a
      // human-friendly verb.
      const { results, cache } = await executeIssueArchive(input, CLI_ISSUE_CACHE_DEPS);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ results, cache }), null, 2)}\n`);
      } else {
        for (const r of results) {
          process.stdout.write(`${renderHumanLine(r)}\n`);
        }
        if (cache.affected.length > 0) {
          process.stdout.write(
            `${chalk.yellow("cache:")} archived issue rows were not refreshed; local cache may be stale until you refresh or remove those rows.\n`,
          );
        }
      }

      if (results.some((r) => r.status === "error" || r.status === "not-found")) {
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

function validateIdentifiers(identifiers: string[]): void {
  const invalid = identifiers.filter((identifier) => !/^[A-Z][A-Z0-9]*-\d+$/.test(identifier));
  if (invalid.length > 0) {
    throw new ValidationError(
      `invalid issue identifier${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`,
      "archive identifiers must look like TEAM-NN; fix the bulk input and retry",
    );
  }
}

function renderHumanLine(r: LifecycleResult): string {
  if (r.status === "ok") {
    return `${chalk.green("✓")} ${chalk.bold(r.identifier)} ${chalk.gray("archived")}`;
  }
  if (r.status === "not-found") {
    return `${chalk.yellow("?")} ${chalk.bold(r.identifier)} ${chalk.yellow("not found")}`;
  }
  return `${chalk.red("✗")} ${chalk.bold(r.identifier)} ${chalk.red(r.error ?? "error")}`;
}
