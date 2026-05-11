import chalk from "chalk";
import type { Command } from "commander";
import { rewriteNotFound } from "../lib/errors.ts";
import { expandIds } from "../lib/expand.ts";
import { linear, withClient } from "../lib/sdk.ts";

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

interface ArchiveResult {
  identifier: string;
  status: "archived" | "not-found" | "error";
  error?: string;
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
      const client = await linear();

      const results: ArchiveResult[] = [];
      for (const ident of identifiers) {
        try {
          // Read with retry; the archive itself is NOT wrapped — retry on
          // already-archived issue would surface as a spurious not-found.
          const issue = await withClient((c) => c.issue(ident));
          if (!issue) {
            results.push({ identifier: ident, status: "not-found" });
            continue;
          }
          await client.client.rawRequest(ARCHIVE_MUTATION, { id: issue.id });
          results.push({ identifier: ident, status: "archived" });
        } catch (err) {
          const translated = rewriteNotFound(err, ident);
          if (translated.message.startsWith("not found:")) {
            results.push({ identifier: ident, status: "not-found" });
          } else {
            results.push({ identifier: ident, status: "error", error: translated.message });
          }
        }
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, results }, null, 2)}\n`);
      } else {
        for (const r of results) {
          const icon =
            r.status === "archived"
              ? chalk.green("✓")
              : r.status === "not-found"
                ? chalk.yellow("?")
                : chalk.red("✗");
          const note =
            r.status === "archived"
              ? chalk.gray("archived")
              : r.status === "not-found"
                ? chalk.yellow("not found")
                : chalk.red(r.error ?? "error");
          process.stdout.write(`${icon} ${chalk.bold(r.identifier)} ${note}\n`);
        }
      }

      if (results.some((r) => r.status === "error" || r.status === "not-found")) {
        process.exitCode = 1;
      }
    });
}

const ARCHIVE_MUTATION = /* GraphQL */ `
  mutation ArchiveIssue($id: String!) {
    issueArchive(id: $id) { success }
  }
`;
