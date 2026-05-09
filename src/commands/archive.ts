import chalk from "chalk";
import type { Command } from "commander";
import { rewriteNotFound } from "../lib/errors.ts";
import { expandIds } from "../lib/expand.ts";
import { linear, withClient } from "../lib/sdk.ts";

interface ArchiveOpts {
  json?: boolean;
}

interface ArchiveResult {
  identifier: string;
  status: "archived" | "not-found" | "error";
  error?: string;
}

export function registerArchive(program: Command): void {
  program
    .command("archive <ids...>")
    .description("archive one or more issues (reversible in Linear UI)")
    .option("--json", "emit structured results")
    .action(async (ids: string[], opts: ArchiveOpts) => {
      const identifiers = expandIds(ids);
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
