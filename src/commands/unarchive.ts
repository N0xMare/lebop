import chalk from "chalk";
import type { Command } from "commander";
import { rewriteNotFound } from "../lib/errors.ts";
import { expandIds } from "../lib/expand.ts";
import { linear, withClient } from "../lib/sdk.ts";

interface UnarchiveOpts {
  json?: boolean;
}

interface UnarchiveResult {
  identifier: string;
  status: "unarchived" | "not-found" | "error";
  error?: string;
}

export function registerUnarchive(program: Command): void {
  program
    .command("unarchive <ids...>")
    .description("unarchive one or more issues (reverse of `archive`)")
    .option("--json", "emit structured results")
    .action(async (ids: string[], opts: UnarchiveOpts) => {
      const identifiers = expandIds(ids);
      const client = await linear();

      const results: UnarchiveResult[] = [];
      for (const ident of identifiers) {
        try {
          // Read with retry; the unarchive itself is NOT wrapped — same
          // reasoning as `archive`: retry on already-unarchived issue would
          // surface as a spurious not-found.
          const issue = await withClient((c) => c.issue(ident));
          if (!issue) {
            results.push({ identifier: ident, status: "not-found" });
            continue;
          }
          await client.client.rawRequest(UNARCHIVE_MUTATION, { id: issue.id });
          results.push({ identifier: ident, status: "unarchived" });
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
            r.status === "unarchived"
              ? chalk.green("✓")
              : r.status === "not-found"
                ? chalk.yellow("?")
                : chalk.red("✗");
          const note =
            r.status === "unarchived"
              ? chalk.gray("unarchived")
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

const UNARCHIVE_MUTATION = /* GraphQL */ `
  mutation UnarchiveIssue($id: String!) {
    issueUnarchive(id: $id) { success }
  }
`;
