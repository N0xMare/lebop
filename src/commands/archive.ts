import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { expandIds } from "../lib/expand.ts";
import { archiveIssues, type LifecycleResult } from "../lib/issues.ts";

interface ArchiveOpts {
  json?: boolean;
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

/** Strip `#` comments + whitespace; return non-empty tokens. */
function parseIdentifierList(text: string): string[] {
  return text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
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
    .option("--json", "emit structured results")
    .action(async (ids: string[], opts: ArchiveOpts) => {
      // Merge args + bulk inputs. Identifier sources combine; ranges
      // (TEAM-101..TEAM-105) are still expanded for any source.
      const fromFile = opts.bulkFile ? await readBulkFile(opts.bulkFile) : [];
      const fromStdin = opts.bulkStdin ? await readBulkStdin() : [];
      const allArgs = [...ids, ...fromFile, ...fromStdin];
      if (allArgs.length === 0) {
        throw new Error(
          "no identifiers — pass them positionally or via --bulk-file / --bulk-stdin",
        );
      }
      const identifiers = expandIds(allArgs);

      // Wave-3 parity: delegate to the lib's archiveIssues so the CLI and MCP
      // emit the same per-row status enum (`"ok"` instead of CLI-only
      // `"archived"`). The human renderer maps the lib enum back to a
      // human-friendly verb.
      const results = await archiveIssues(identifiers);

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
    return `${chalk.green("✓")} ${chalk.bold(r.identifier)} ${chalk.gray("archived")}`;
  }
  if (r.status === "not-found") {
    return `${chalk.yellow("?")} ${chalk.bold(r.identifier)} ${chalk.yellow("not found")}`;
  }
  return `${chalk.red("✗")} ${chalk.bold(r.identifier)} ${chalk.red(r.error ?? "error")}`;
}
