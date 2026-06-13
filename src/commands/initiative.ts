import chalk from "chalk";
import type { Command } from "commander";
import { parseCliLimit, parseCliNumber } from "../lib/cliOptions.ts";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
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
        const max = parseCliLimit(opts.limit, { defaultValue: 50, zeroMeansInfinity: true });
        const initiatives = await listInitiatives({
          status: opts.status,
          ownerId: opts.ownerId,
          includeArchived: opts.includeArchived ?? opts.archived,
          max,
        });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope({ count: initiatives.length, initiatives }), null, 2)}\n`,
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
      if (!id) throw new NotFoundError(`initiative not found: ${idOrName}`);
      const initiative = await getInitiative(id);
      if (!initiative) throw new NotFoundError(`initiative not found: ${idOrName}`);

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
        const input: Parameters<typeof updateInitiative>[1] = {};
        if (opts.name !== undefined) input.name = opts.name;
        if (opts.description !== undefined) input.description = opts.description;
        if (opts.status !== undefined) input.status = opts.status;
        if (opts.ownerId !== undefined && opts.clearOwner) {
          throw new ValidationError(
            "pass either --owner-id or --clear-owner, not both",
            "use --clear-owner to remove ownership, or --owner-id <uuid> to assign an owner",
          );
        }
        if (opts.clearOwner) input.ownerId = null;
        if (opts.ownerId !== undefined)
          input.ownerId = opts.ownerId === "null" ? null : opts.ownerId;
        if (opts.targetDate !== undefined) {
          input.targetDate = opts.targetDate === "null" ? null : opts.targetDate;
        }
        if (opts.color !== undefined) input.color = opts.color;
        if (opts.icon !== undefined) input.icon = opts.icon;

        if (Object.keys(input).length === 0) {
          throw new ValidationError(
            "nothing to update — pass at least one field",
            "pass --name, --description, --status, --owner-id, --target-date, --color, or --icon",
          );
        }

        const resolvedId = await resolveInitiativeId(id);
        if (!resolvedId) throw new NotFoundError(`initiative not found: ${id}`);
        const updated = await updateInitiative(resolvedId, input);
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
      if (!opts.yes) {
        throw new ValidationError(
          "refusing to archive initiative without --yes",
          "re-run with --yes to confirm this destructive state change",
        );
      }
      const resolvedId = await resolveInitiativeId(id);
      if (!resolvedId) throw new NotFoundError(`initiative not found: ${id}`);
      const success = await archiveInitiative(resolvedId);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ id: resolvedId, success }), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${chalk.green("✓")} archived ${chalk.bold(resolvedId)}\n`);
    });

  cmd
    .command("unarchive <id-or-name>")
    .description("unarchive an initiative. Accepts UUID or exact initiative name.")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const resolvedId = await resolveInitiativeId(id);
      if (!resolvedId) throw new NotFoundError(`initiative not found: ${id}`);
      const success = await unarchiveInitiative(resolvedId);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ id: resolvedId, success }), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${chalk.green("✓")} unarchived ${chalk.bold(resolvedId)}\n`);
    });

  cmd
    .command("delete <id-or-name>")
    .description(
      "delete an initiative permanently (irreversible — requires --yes). Accepts UUID or exact initiative name.",
    )
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      if (!opts.yes) {
        throw new ValidationError(
          `refusing to delete initiative ${id} without --yes`,
          "re-run with --yes to confirm. Use `initiative archive` for a reversible alternative.",
        );
      }
      // Round-9 / M-1: envelope `id` field must have a consistent shape across
      // both deleted and already-absent branches so `jq -r .id` doesn't get a
      // name-string in one case and a UUID in the other. When name lookup
      // fails, we have no UUID — emit `id: null` and a separate `query`
      // field carrying the original lookup token so callers can still
      // identify which target the response refers to.
      const resolvedId = await resolveInitiativeId(id);
      if (!resolvedId) {
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope({ id: null, query: id, status: "already-absent", success: false }), null, 2)}\n`,
          );
        } else {
          process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(id)} (no-op)\n`);
        }
        return;
      }
      // Round-8 / N2: discriminated union — narrow via `r.status`.
      const r = await tryIdempotentDelete(() => deleteInitiative(resolvedId));
      const succeeded = r.status === "deleted" && r.result;
      if (r.status === "deleted" && !r.result) process.exitCode = 1;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ id: resolvedId, query: id, status: r.status, success: succeeded }), null, 2)}\n`,
        );
        return;
      }
      if (r.status === "already-absent") {
        process.stdout.write(
          `${chalk.gray("✓")} already absent: ${chalk.bold(resolvedId)} (no-op)\n`,
        );
      } else if (r.result) {
        process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(resolvedId)}\n`);
      }
    });

  cmd
    .command("add-project <initiative> <project>")
    .description("link a project to an initiative (server-idempotent)")
    .option("--sort-order <n>")
    .option("--json", "emit structured result")
    .action(
      async (initiative: string, project: string, opts: { sortOrder?: string; json?: boolean }) => {
        const sortOrder =
          opts.sortOrder !== undefined
            ? parseCliNumber(opts.sortOrder, { optionName: "--sort-order", allowNegative: true })
            : undefined;
        const initiativeId = await resolveInitiativeId(initiative);
        if (!initiativeId) throw new NotFoundError(`initiative not found: ${initiative}`);
        const projectId = await resolveProjectId(project);
        if (!projectId) throw new NotFoundError(`project not found: ${project}`);
        const result = await initiativeAddProject({
          initiativeId,
          projectId,
          sortOrder,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope({ edge_id: result.id }), null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} linked ${chalk.bold(project)} → ${chalk.bold(initiative)} ${chalk.gray(`(${result.id})`)}\n`,
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
        if (!opts.yes) {
          throw new ValidationError(
            "refusing to remove project from initiative without --yes",
            "re-run with --yes to confirm this destructive state change",
          );
        }
        const initiativeId = await resolveInitiativeId(initiative);
        if (!initiativeId) throw new NotFoundError(`initiative not found: ${initiative}`);
        const projectId = await resolveProjectId(project);
        if (!projectId) throw new NotFoundError(`project not found: ${project}`);
        const result = await initiativeRemoveProject({ initiativeId, projectId });
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
