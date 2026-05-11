import chalk from "chalk";
import type { Command } from "commander";
import {
  createLink,
  deleteLink,
  findLink,
  LINK_KINDS,
  type LinkKind,
  listRelations,
} from "../lib/relations.ts";
import { withClient } from "../lib/sdk.ts";

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
    .option("--json", "emit structured result")
    .action(async (id: string, kind: string, other: string, opts: { json?: boolean }) => {
      const linkKind = parseKind(kind);
      const upperId = id.toUpperCase();
      const upperOther = other.toUpperCase();

      // Resolve both issues to UUIDs in parallel.
      const [self, target] = await Promise.all([
        withClient((c) => c.issue(upperId)),
        withClient((c) => c.issue(upperOther)),
      ]);
      if (!self) throw new Error(`issue not found: ${upperId}`);
      if (!target) throw new Error(`link target not found: ${upperOther}`);

      const result = await createLink(self.id, target.id, linkKind);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              op: "add",
              from: upperId,
              kind: linkKind,
              to: upperOther,
              relation_id: result.id,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      process.stdout.write(
        `${chalk.green("✓")} ${chalk.bold(upperId)} ${chalk.cyan(linkKind)} ${chalk.bold(upperOther)} ${chalk.gray(`(${result.id})`)}\n`,
      );
    });

  rel
    .command("delete <id> <kind> <other>")
    .description("remove a relation between two issues")
    .option("--json", "emit structured result")
    .action(async (id: string, kind: string, other: string, opts: { json?: boolean }) => {
      const linkKind = parseKind(kind);
      const upperId = id.toUpperCase();
      const upperOther = other.toUpperCase();

      const relationId = await findLink(upperId, upperOther, linkKind);
      if (!relationId) {
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                schema_version: 1,
                op: "delete",
                from: upperId,
                kind: linkKind,
                to: upperOther,
                status: "already-absent",
              },
              null,
              2,
            )}\n`,
          );
        } else {
          process.stdout.write(
            `${chalk.gray("·")} ${chalk.bold(upperId)} ${chalk.cyan(linkKind)} ${chalk.bold(upperOther)} ${chalk.gray("(already absent)")}\n`,
          );
        }
        return;
      }

      await deleteLink(relationId);
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              op: "delete",
              from: upperId,
              kind: linkKind,
              to: upperOther,
              status: "deleted",
              relation_id: relationId,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      process.stdout.write(
        `${chalk.green("✓")} removed ${chalk.bold(upperId)} ${chalk.cyan(linkKind)} ${chalk.bold(upperOther)} ${chalk.gray(`(${relationId})`)}\n`,
      );
    });

  rel
    .command("list <id>")
    .description("list outbound + inbound relations for an issue")
    .option("--json", "emit structured records")
    .action(async (id: string, opts: { json?: boolean }) => {
      const upperId = id.toUpperCase();
      const { outbound, inbound } = await listRelations(upperId);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              identifier: upperId,
              outbound,
              inbound,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (outbound.length === 0 && inbound.length === 0) {
        process.stdout.write(`${chalk.gray("(no relations)")}\n`);
        return;
      }
      for (const r of outbound) {
        process.stdout.write(
          `${chalk.gray("→")} ${chalk.cyan(r.type)} ${chalk.bold(r.otherIdentifier)}\n`,
        );
      }
      for (const r of inbound) {
        process.stdout.write(
          `${chalk.gray("←")} ${chalk.cyan(r.type)} ${chalk.bold(r.otherIdentifier)}\n`,
        );
      }
    });
}

function parseKind(input: string): LinkKind {
  const normalized = input.toLowerCase().replace(/_/g, "-");
  if (!(LINK_KINDS as readonly string[]).includes(normalized)) {
    throw new Error(
      `unknown relation kind "${input}". supported: ${LINK_KINDS.join(", ")} (use \`lebop raw\` for \`similar\`)`,
    );
  }
  return normalized as LinkKind;
}
