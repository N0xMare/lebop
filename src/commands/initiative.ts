import chalk from "chalk";
import type { Command } from "commander";
import {
  archiveInitiative,
  createInitiative,
  deleteInitiative,
  getInitiative,
  initiativeAddProject,
  initiativeRemoveProject,
  listInitiatives,
  resolveInitiativeId,
  unarchiveInitiative,
  updateInitiative,
} from "../lib/initiatives.ts";
import { resolveProjectId } from "../lib/milestones.ts";

export function registerInitiative(program: Command): void {
  const cmd = program
    .command("initiative")
    .description("manage Linear initiatives (org-level planning)");

  cmd
    .command("list")
    .description("list initiatives")
    .option("--status <name>", "filter by status name")
    .option("--archived", "include archived initiatives")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured records")
    .action(
      async (opts: {
        status?: string;
        archived?: boolean;
        limit?: string;
        json?: boolean;
      }) => {
        const requested = Number.parseInt(opts.limit ?? "50", 10);
        const max = requested === 0 ? Number.POSITIVE_INFINITY : Math.max(1, requested);
        const initiatives = await listInitiatives({
          status: opts.status,
          includeArchived: opts.archived,
          max,
        });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              { schema_version: 1, count: initiatives.length, initiatives },
              null,
              2,
            )}\n`,
          );
          return;
        }

        if (initiatives.length === 0) {
          process.stdout.write("no initiatives\n");
          return;
        }
        const nameWidth = Math.max(...initiatives.map((i) => i.name.length));
        for (const i of initiatives) {
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
      const id = await resolveInitiativeId(idOrName);
      if (!id) throw new Error(`initiative not found: ${idOrName}`);
      const initiative = await getInitiative(id);
      if (!initiative) throw new Error(`initiative not found: ${idOrName}`);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, initiative }, null, 2)}\n`);
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
        const created = await createInitiative({
          name,
          description: opts.description,
          status: opts.status,
          ownerId: opts.ownerId,
          targetDate: opts.targetDate,
          color: opts.color,
          icon: opts.icon,
        });
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ schema_version: 1, initiative: created }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} created ${chalk.bold(created.name)} ${chalk.gray(`(${created.id})`)}\n${chalk.gray(created.url)}\n`,
        );
      },
    );

  cmd
    .command("update <id>")
    .description("update an initiative (idempotent)")
    .option("--name <text>")
    .option("--description <text>")
    .option("--status <name>")
    .option("--owner-id <uuid>")
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
          targetDate?: string;
          color?: string;
          icon?: string;
          json?: boolean;
        },
      ) => {
        const input: Parameters<typeof updateInitiative>[1] = {};
        if (opts.name !== undefined) input.name = opts.name;
        if (opts.description !== undefined) input.description = opts.description;
        if (opts.status !== undefined) input.status = opts.status;
        if (opts.ownerId !== undefined) input.ownerId = opts.ownerId;
        if (opts.targetDate !== undefined) {
          input.targetDate = opts.targetDate === "null" ? null : opts.targetDate;
        }
        if (opts.color !== undefined) input.color = opts.color;
        if (opts.icon !== undefined) input.icon = opts.icon;

        if (Object.keys(input).length === 0) {
          throw new Error("nothing to update — pass at least one field");
        }

        const updated = await updateInitiative(id, input);
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ schema_version: 1, initiative: updated }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated ${chalk.bold(updated.name)} ${chalk.gray(`(${updated.id})`)}\n`,
        );
      },
    );

  cmd
    .command("archive <id>")
    .description("archive an initiative (reversible)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const success = await archiveInitiative(id);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, id, success }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${chalk.green("✓")} archived ${chalk.bold(id)}\n`);
    });

  cmd
    .command("unarchive <id>")
    .description("unarchive an initiative")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const success = await unarchiveInitiative(id);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, id, success }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${chalk.green("✓")} unarchived ${chalk.bold(id)}\n`);
    });

  cmd
    .command("delete <id>")
    .description("delete an initiative permanently")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const success = await deleteInitiative(id);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, id, success }, null, 2)}\n`);
        return;
      }
      if (success) process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(id)}\n`);
      else process.exitCode = 1;
    });

  cmd
    .command("add-project <initiative> <project>")
    .description("link a project to an initiative (server-idempotent)")
    .option("--sort-order <n>")
    .option("--json", "emit structured result")
    .action(
      async (initiative: string, project: string, opts: { sortOrder?: string; json?: boolean }) => {
        const initiativeId = await resolveInitiativeId(initiative);
        if (!initiativeId) throw new Error(`initiative not found: ${initiative}`);
        const projectId = await resolveProjectId(project);
        if (!projectId) throw new Error(`project not found: ${project}`);
        const result = await initiativeAddProject({
          initiativeId,
          projectId,
          sortOrder: opts.sortOrder !== undefined ? Number(opts.sortOrder) : undefined,
        });
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ schema_version: 1, edge_id: result.id }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} linked ${chalk.bold(project)} → ${chalk.bold(initiative)} ${chalk.gray(`(${result.id})`)}\n`,
        );
      },
    );

  cmd
    .command("remove-project <initiative> <project>")
    .description("remove a project from an initiative")
    .option("--json", "emit structured result")
    .action(async (initiative: string, project: string, opts: { json?: boolean }) => {
      const initiativeId = await resolveInitiativeId(initiative);
      if (!initiativeId) throw new Error(`initiative not found: ${initiative}`);
      const projectId = await resolveProjectId(project);
      if (!projectId) throw new Error(`project not found: ${project}`);
      const success = await initiativeRemoveProject({ initiativeId, projectId });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, success }, null, 2)}\n`);
        return;
      }
      if (success) {
        process.stdout.write(
          `${chalk.green("✓")} unlinked ${chalk.bold(project)} from ${chalk.bold(initiative)}\n`,
        );
      } else {
        process.stdout.write(`${chalk.gray("·")} ${project} was not linked to ${initiative}\n`);
      }
    });
}
