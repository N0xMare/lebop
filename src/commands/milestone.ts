import chalk from "chalk";
import type { Command } from "commander";
import { parseCliNumber } from "../lib/cliOptions.ts";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  listMilestones,
  resolveExistingProjectId,
  resolveProjectId,
  updateMilestone,
} from "../lib/milestones.ts";

/**
 * `lebop milestone list|view|create|update|delete` — project milestones.
 */
export function registerMilestone(program: Command): void {
  const cmd = program.command("milestone").description("manage project milestones");

  cmd
    .command("list")
    .description("list milestones; --project filters to one project")
    .option("--project <name-or-id>", "project name or UUID")
    .option(
      "--include-archived",
      "also surface cascade-archived milestones (parent-project archived). Defaults to false (live only).",
    )
    .option("--json", "emit structured records")
    .action(async (opts: { project?: string; includeArchived?: boolean; json?: boolean }) => {
      let projectId: string | undefined;
      if (opts.project) {
        const resolved = await resolveExistingProjectId(opts.project);
        if (!resolved) throw new NotFoundError(`project not found: ${opts.project}`);
        projectId = resolved;
      }
      // Round-8 / M4: CLI parity with the MCP `list_milestones`
      // `include_archived` arg (round-7 / HIGH-2). Lib already accepts the
      // option; only the CLI flag was missing.
      const milestones = await listMilestones({
        projectId,
        includeArchived: Boolean(opts.includeArchived),
      });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ count: milestones.length, milestones }), null, 2)}\n`,
        );
        return;
      }

      if (milestones.length === 0) {
        process.stdout.write("no milestones\n");
        return;
      }
      const nameWidth = Math.max(...milestones.map((m) => m.name.length));
      for (const m of milestones) {
        const date = m.target_date ? chalk.gray(`(${m.target_date})`) : "";
        process.stdout.write(
          `${chalk.bold(m.name.padEnd(nameWidth))}  ${chalk.cyan(m.project.name)}  ${date}\n`,
        );
      }
    });

  cmd
    .command("view <id>")
    .description("show one milestone by UUID")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const milestone = await getMilestone(id);
      if (!milestone) throw new NotFoundError(`milestone not found: ${id}`);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ milestone }), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${chalk.bold(milestone.name)}\n`);
      process.stdout.write(`  project: ${milestone.project.name} (${milestone.project.id})\n`);
      if (milestone.target_date) {
        process.stdout.write(`  target_date: ${milestone.target_date}\n`);
      }
      process.stdout.write(`  sort_order: ${milestone.sort_order}\n`);
      if (milestone.description) {
        process.stdout.write(`\n${milestone.description}\n`);
      }
    });

  cmd
    .command("create <name>")
    .description("create a milestone in a project")
    // Round-6 / H17: `--project` and `--project-id` are siblings (parity with
    // `lebop new`). `--project` accepts a name OR UUID; `--project-id` is
    // UUID-only (skips the name lookup). One of them is required; we
    // validate that in the handler so the help text stays clean.
    .option("--project <name-or-id>", "project name or UUID")
    .option("--project-id <uuid>", "project UUID (alternative to --project)")
    .option("--description <text>")
    .option("--target-date <iso-date>", "e.g. 2026-12-31")
    .option("--sort-order <n>", "numeric sort order")
    .option("--json", "emit structured result")
    .action(
      async (
        name: string,
        opts: {
          project?: string;
          projectId?: string;
          description?: string;
          targetDate?: string;
          sortOrder?: string;
          json?: boolean;
        },
      ) => {
        // Round-7 / MED-5: enforce mutual-exclusion (the round-6 H17
        // sibling-flags work allowed both silently — `--project-id` won).
        if (opts.project && opts.projectId) {
          throw new ValidationError(
            "pass exactly one of --project / --project-id, not both",
            "choose one project selector",
          );
        }
        if (!opts.project && !opts.projectId) {
          throw new ValidationError(
            "either --project <name-or-id> or --project-id <uuid> is required",
            "milestones must be created inside a project",
          );
        }
        const sortOrder =
          opts.sortOrder !== undefined
            ? parseCliNumber(opts.sortOrder, { optionName: "--sort-order", allowNegative: true })
            : undefined;
        const projectId = opts.projectId ?? (await resolveProjectId(opts.project as string));
        if (!projectId) throw new NotFoundError(`project not found: ${opts.project}`);
        const created = await createMilestone({
          name,
          projectId,
          description: opts.description,
          targetDate: opts.targetDate,
          sortOrder,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope({ milestone: created }), null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} created ${chalk.bold(created.name)} ${chalk.gray(`(${created.id})`)} in ${chalk.cyan(created.project.name)}\n`,
        );
      },
    );

  cmd
    .command("update <id>")
    .description("update a milestone (name, description, target-date, sort-order, project)")
    .option("--name <text>")
    .option("--description <text>")
    .option("--target-date <iso-date>", "or `null` to clear")
    .option("--sort-order <n>")
    .option("--project <name-or-id>", "move to a different project")
    .option("--json", "emit structured result")
    .action(
      async (
        id: string,
        opts: {
          name?: string;
          description?: string;
          targetDate?: string;
          sortOrder?: string;
          project?: string;
          json?: boolean;
        },
      ) => {
        const input: Parameters<typeof updateMilestone>[1] = {};
        if (opts.name !== undefined) input.name = opts.name;
        if (opts.description !== undefined) input.description = opts.description;
        if (opts.targetDate !== undefined) {
          input.targetDate = opts.targetDate === "null" ? null : opts.targetDate;
        }
        if (opts.sortOrder !== undefined) {
          input.sortOrder = parseCliNumber(opts.sortOrder, {
            optionName: "--sort-order",
            allowNegative: true,
          });
        }
        if (opts.project !== undefined) {
          const projectId = await resolveProjectId(opts.project);
          if (!projectId) throw new NotFoundError(`project not found: ${opts.project}`);
          input.projectId = projectId;
        }

        if (Object.keys(input).length === 0) {
          throw new ValidationError(
            "nothing to update — pass at least one of --name / --description / --target-date / --sort-order / --project",
            "pass at least one update field",
          );
        }

        const updated = await updateMilestone(id, input);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope({ milestone: updated }), null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated ${chalk.bold(updated.name)} ${chalk.gray(`(${updated.id})`)}\n`,
        );
      },
    );

  cmd
    .command("delete <id>")
    .description("delete a milestone by UUID (irreversible — requires --yes)")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      if (!opts.yes) {
        throw new ValidationError(
          `refusing to delete milestone ${id} without --yes`,
          "re-run with --yes to confirm. This operation is irreversible.",
        );
      }
      // Round-8 / N2: discriminated union — narrow via `r.status`.
      const r = await tryIdempotentDelete(() => deleteMilestone(id));
      const succeeded = r.status === "deleted" && r.result;
      if (r.status === "deleted" && !r.result) process.exitCode = 1;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ id, status: r.status, success: succeeded }), null, 2)}\n`,
        );
        return;
      }
      if (r.status === "already-absent") {
        process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(id)} (no-op)\n`);
      } else if (r.result) {
        process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(id)}\n`);
      } else {
        process.stdout.write(`${chalk.red("✗")} delete failed for ${id}\n`);
      }
    });
}
