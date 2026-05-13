import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError, tryIdempotentDelete } from "../lib/errors.ts";
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
    .option("--include-archived", "include archived initiatives (alias: --archived)")
    .option("--archived", "[deprecated] include archived initiatives — use --include-archived")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured records")
    .action(
      async (opts: {
        status?: string;
        archived?: boolean;
        includeArchived?: boolean;
        limit?: string;
        json?: boolean;
      }) => {
        const requested = Number.parseInt(opts.limit ?? "50", 10);
        const max = requested === 0 ? Number.POSITIVE_INFINITY : Math.max(1, requested);
        const initiatives = await listInitiatives({
          status: opts.status,
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
          // Round-10 / M8 deferred: this surfaces as `code: "unknown"` in
          // `--json` envelopes instead of `validation_error`. Deliberately
          // not migrated this release — the broader CLI ValidationError
          // sweep is a v1.0 polish item, not a v0.0.2 ship blocker.
          throw new Error("nothing to update — pass at least one field");
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
    .description("archive an initiative (reversible). Accepts UUID or exact initiative name.")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
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
        process.stderr.write(
          `${chalk.red("error:")} refusing to delete initiative ${chalk.bold(id)} without --yes\n` +
            `  ${chalk.cyan("hint:")} re-run with --yes to confirm. Use \`initiative archive\` for a reversible alternative.\n`,
        );
        process.exitCode = 1;
        return;
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
        const initiativeId = await resolveInitiativeId(initiative);
        if (!initiativeId) throw new NotFoundError(`initiative not found: ${initiative}`);
        const projectId = await resolveProjectId(project);
        if (!projectId) throw new NotFoundError(`project not found: ${project}`);
        const result = await initiativeAddProject({
          initiativeId,
          projectId,
          sortOrder: opts.sortOrder !== undefined ? Number(opts.sortOrder) : undefined,
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
    .description("remove a project from an initiative")
    .option("--json", "emit structured result")
    .action(async (initiative: string, project: string, opts: { json?: boolean }) => {
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
    });
}
