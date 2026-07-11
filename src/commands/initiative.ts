import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import {
  buildInitiativeAddProjectInputFromCli,
  buildInitiativeArchiveInputFromCli,
  buildInitiativeCreateInputFromCli,
  buildInitiativeDeleteInputFromCli,
  buildInitiativeGetInput,
  buildInitiativeListInputFromCli,
  buildInitiativeRemoveProjectInputFromCli,
  buildInitiativeUnarchiveInput,
  buildInitiativeUpdateInputFromCli,
  executeInitiativeAddProject,
  executeInitiativeArchive,
  executeInitiativeCreate,
  executeInitiativeDelete,
  executeInitiativeGet,
  executeInitiativeList,
  executeInitiativeRemoveProject,
  executeInitiativeUnarchive,
  executeInitiativeUpdate,
  initiativeDeleteCliSuccess,
  initiativeDeletePayload,
  initiativeListPayload,
} from "../surface/initiatives.ts";

export function registerInitiative(program: Command): void {
  const cmd = program
    .command("initiative")
    .description("manage Linear initiatives (org-level planning)");

  cmd
    .command("list")
    .description("list initiatives")
    .option("--status <name>", "filter by status name")
    .option("--owner-id <uuid>", "filter by owner user UUID")
    .option("--include-archived", "include archived initiatives (alias: --archived)")
    .option("--archived", "[deprecated] include archived initiatives — use --include-archived")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured records")
    .action(
      async (opts: {
        status?: string;
        ownerId?: string;
        archived?: boolean;
        includeArchived?: boolean;
        limit?: string;
        json?: boolean;
      }) => {
        const result = await executeInitiativeList(buildInitiativeListInputFromCli({ opts }));

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope(initiativeListPayload(result)), null, 2)}\n`,
          );
          return;
        }

        if (result.initiatives.length === 0) {
          process.stdout.write("no initiatives\n");
          return;
        }
        const nameWidth = Math.max(...result.initiatives.map((i) => i.name.length));
        for (const i of result.initiatives) {
          const status = i.status ? chalk.cyan(`[${i.status}]`) : chalk.gray("[no status]");
          const date = i.target_date ? chalk.gray(`(${i.target_date})`) : "";
          const arch = i.archived_at ? chalk.gray(" [archived]") : "";
          process.stdout.write(
            `${chalk.bold(i.name.padEnd(nameWidth))}  ${status} ${date}${arch}\n`,
          );
        }
      },
    );

  cmd
    .command("view <id-or-name>")
    .description("show one initiative (with projects)")
    .option("--json", "emit structured result")
    .action(async (idOrName: string, opts: { json?: boolean }) => {
      const initiative = await executeInitiativeGet(buildInitiativeGetInput(idOrName));

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ initiative }), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${chalk.bold(initiative.name)}\n`);
      if (initiative.status) process.stdout.write(`  status: ${chalk.cyan(initiative.status)}\n`);
      if (initiative.owner) {
        process.stdout.write(`  owner: ${initiative.owner.name} <${initiative.owner.email}>\n`);
      }
      if (initiative.target_date) process.stdout.write(`  target: ${initiative.target_date}\n`);
      process.stdout.write(`  url: ${chalk.gray(initiative.url)}\n`);
      if (initiative.description) process.stdout.write(`\n${initiative.description}\n`);
      if (initiative.projects.length > 0) {
        process.stdout.write(`\n${chalk.gray("── projects ──")}\n`);
        for (const p of initiative.projects) {
          process.stdout.write(`  ${chalk.bold(p.name)} ${chalk.gray(`[${p.state}]`)}\n`);
        }
      }
    });

  cmd
    .command("create <name>")
    .description("create an initiative")
    .option("--description <text>")
    .option("--status <name>")
    .option("--owner-id <uuid>")
    .option("--target-date <iso>")
    .option("--color <hex>")
    .option("--icon <name>")
    .option("--json", "emit structured result")
    .action(
      async (
        name: string,
        opts: {
          description?: string;
          status?: string;
          ownerId?: string;
          targetDate?: string;
          color?: string;
          icon?: string;
          json?: boolean;
        },
      ) => {
        const created = await executeInitiativeCreate(
          buildInitiativeCreateInputFromCli({ name, opts }),
        );
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope({ initiative: created }), null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} created ${chalk.bold(created.name)} ${chalk.gray(`(${created.id})`)}\n${chalk.gray(created.url)}\n`,
        );
      },
    );

  cmd
    .command("update <id-or-name>")
    .description("update an initiative (idempotent). Accepts UUID or exact initiative name.")
    .option("--name <text>")
    .option("--description <text>")
    .option("--status <name>")
    .option("--owner-id <uuid>", "or `null` to clear")
    .option("--clear-owner", "clear the initiative owner")
    .option("--target-date <iso>", "or `null` to clear")
    .option("--color <hex>")
    .option("--icon <name>")
    .option("--json", "emit structured result")
    .action(
      async (
        id: string,
        opts: {
          name?: string;
          description?: string;
          status?: string;
          ownerId?: string;
          clearOwner?: boolean;
          targetDate?: string;
          color?: string;
          icon?: string;
          json?: boolean;
        },
      ) => {
        const updated = await executeInitiativeUpdate(
          buildInitiativeUpdateInputFromCli({ id, opts }),
        );
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope({ initiative: updated }), null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated ${chalk.bold(updated.name)} ${chalk.gray(`(${updated.id})`)}\n`,
        );
      },
    );

  cmd
    .command("archive <id-or-name>")
    .description(
      "archive an initiative (reversible — requires --yes). Accepts UUID or exact initiative name.",
    )
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean; yes?: boolean }) => {
      const result = await executeInitiativeArchive(
        buildInitiativeArchiveInputFromCli({ id, opts }),
      );
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ id: result.id, success: result.success }), null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(`${chalk.green("✓")} archived ${chalk.bold(result.id)}\n`);
    });

  cmd
    .command("unarchive <id-or-name>")
    .description("unarchive an initiative. Accepts UUID or exact initiative name.")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const result = await executeInitiativeUnarchive(buildInitiativeUnarchiveInput(id));
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ id: result.id, success: result.success }), null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(`${chalk.green("✓")} unarchived ${chalk.bold(result.id)}\n`);
    });

  cmd
    .command("delete <id-or-name>")
    .description(
      "delete an initiative permanently (irreversible — requires --yes). Accepts UUID or exact initiative name.",
    )
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      const r = await executeInitiativeDelete(buildInitiativeDeleteInputFromCli({ id, opts }));
      const succeeded = initiativeDeleteCliSuccess(r);
      if (r.status === "deleted" && !r.result) process.exitCode = 1;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope(initiativeDeletePayload(r, succeeded)), null, 2)}\n`,
        );
        return;
      }
      if (r.id === null) {
        process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(id)} (no-op)\n`);
      } else if (r.status === "already-absent") {
        process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(r.id)} (no-op)\n`);
      } else if (r.result) {
        process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(r.id)}\n`);
      }
    });

  cmd
    .command("add-project <initiative> <project>")
    .description("link a project to an initiative (server-idempotent)")
    .option("--sort-order <n>")
    .option("--json", "emit structured result")
    .action(
      async (initiative: string, project: string, opts: { sortOrder?: string; json?: boolean }) => {
        const result = await executeInitiativeAddProject(
          buildInitiativeAddProjectInputFromCli({ initiative, project, opts }),
        );
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope({ edge_id: result.edge_id }), null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} linked ${chalk.bold(project)} → ${chalk.bold(initiative)} ${chalk.gray(`(${result.edge_id})`)}\n`,
        );
      },
    );

  cmd
    .command("remove-project <initiative> <project>")
    .description("remove a project from an initiative (requires --yes)")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(
      async (initiative: string, project: string, opts: { json?: boolean; yes?: boolean }) => {
        const result = await executeInitiativeRemoveProject(
          buildInitiativeRemoveProjectInputFromCli({ initiative, project, opts }),
        );
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope({ ...result }), null, 2)}\n`);
          return;
        }
        if (result.removed) {
          process.stdout.write(
            `${chalk.green("✓")} unlinked ${chalk.bold(project)} from ${chalk.bold(initiative)}\n`,
          );
          return;
        }
        const reasonText =
          result.reason === "absent"
            ? `${project} was not linked to ${initiative}`
            : result.reason === "archived"
              ? `${initiative} is archived — unarchive it first to remove projects`
              : (result.message ?? `removal refused (reason: ${result.reason ?? "unknown"})`);
        process.stdout.write(`${chalk.gray("·")} ${reasonText}\n`);
      },
    );
}
