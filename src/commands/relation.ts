import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { LINK_KINDS } from "../lib/relations.ts";
import {
  buildRelationAddInputFromCli,
  buildRelationDeleteInputFromCli,
  buildRelationListInputFromCli,
  executeRelationAdd,
  executeRelationDelete,
  executeRelationList,
  relationAddCliPayload,
  relationDeleteCliPayload,
  relationListPayload,
} from "../surface/relations.ts";

/**
 * `lebop relation add|delete|list` — first-class wrapper around lib/relations.ts.
 * Pair with `lebop set links +KIND:TARGET -KIND:TARGET ...` for batched delta
 * mutations on a single issue. The two surfaces are equivalent under the hood;
 * `relation` is per-pair, more readable for one-offs and MCP tools.
 */
export function registerRelation(program: Command): void {
  const rel = program
    .command("relation")
    .description("manage issue relations (blocks, related, etc.)");

  rel
    .command("add <id> <kind> <other>")
    .description(
      `add a relation between two issues. kinds: ${LINK_KINDS.join(" | ")}. (use \`lebop raw\` for \`similar\`, which lebop deliberately omits.)`,
    )
    .option(
      "--yes",
      "confirm replacement/destructive relation creation when an existing pair relation would be replaced or a duplicate relation may move issue state",
    )
    .option("--json", "emit structured result")
    .action(
      async (id: string, kind: string, other: string, opts: { json?: boolean; yes?: boolean }) => {
        const result = await executeRelationAdd(
          buildRelationAddInputFromCli({ id, kind, other, opts }),
        );

        if (result.status === "unchanged") {
          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify(envelope(relationAddCliPayload(result)), null, 2)}\n`,
            );
            return;
          }
          process.stdout.write(
            `${chalk.gray("·")} ${chalk.bold(result.requestedFrom)} ${chalk.cyan(result.kind)} ${chalk.bold(result.to)} ${chalk.gray(`(${result.relationId}, already present)`)}\n`,
          );
          return;
        }

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope(relationAddCliPayload(result)), null, 2)}\n`,
          );
          if (result.writebackFailed) process.exitCode = 1;
          return;
        }
        if (result.writebackFailed) {
          process.stdout.write(
            `${chalk.red("✗")} ${chalk.bold(result.requestedFrom)} ${chalk.cyan(result.kind)} ${chalk.bold(result.to)} created in Linear but local cache writeback failed: ${result.cache.error?.message ?? "unknown error"}\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} ${chalk.bold(result.requestedFrom)} ${chalk.cyan(result.kind)} ${chalk.bold(result.to)} ${chalk.gray(`(${result.relationId})`)}${result.cache.refreshed ? chalk.gray(" (cache refreshed)") : ""}\n`,
        );
      },
    );

  rel
    .command("delete <id> <kind> <other>")
    .description("remove a relation between two issues (requires --yes)")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(
      async (id: string, kind: string, other: string, opts: { json?: boolean; yes?: boolean }) => {
        const result = await executeRelationDelete(
          buildRelationDeleteInputFromCli({ id, kind, other, opts }),
        );

        if (result.status === "already-absent") {
          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify(envelope(relationDeleteCliPayload(result)), null, 2)}\n`,
            );
          } else {
            process.stdout.write(
              `${chalk.gray("·")} ${chalk.bold(result.from)} ${chalk.cyan(result.kind)} ${chalk.bold(result.to)} ${chalk.gray("(already absent)")}\n`,
            );
          }
          return;
        }

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope(relationDeleteCliPayload(result)), null, 2)}\n`,
          );
          if (result.writebackFailed) process.exitCode = 1;
          return;
        }
        if (result.writebackFailed) {
          process.stdout.write(
            `${chalk.red("✗")} removed ${chalk.bold(result.from)} ${chalk.cyan(result.kind)} ${chalk.bold(result.to)} in Linear but local cache writeback failed: ${result.cache?.error?.message ?? "unknown error"}\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} removed ${chalk.bold(result.from)} ${chalk.cyan(result.kind)} ${chalk.bold(result.to)} ${chalk.gray(`(${result.relationId})`)}${result.cache?.refreshed ? chalk.gray(" (cache refreshed)") : ""}\n`,
        );
      },
    );

  rel
    .command("list <id>")
    .description("list outbound + inbound relations for an issue")
    .option("--json", "emit structured records")
    .action(async (id: string, opts: { json?: boolean }) => {
      const result = await executeRelationList(buildRelationListInputFromCli({ id }));

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(relationListPayload(result)), null, 2)}\n`);
        return;
      }

      if (result.outbound.length === 0 && result.inbound.length === 0) {
        process.stdout.write(`${chalk.gray("(no relations)")}\n`);
        return;
      }
      for (const r of result.outbound) {
        process.stdout.write(
          `${chalk.gray("→")} ${chalk.cyan(r.type)} ${chalk.bold(r.otherIdentifier)}\n`,
        );
      }
      for (const r of result.inbound) {
        process.stdout.write(
          `${chalk.gray("←")} ${chalk.cyan(r.type)} ${chalk.bold(r.otherIdentifier)}\n`,
        );
      }
    });
}
