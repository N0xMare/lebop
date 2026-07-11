import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import {
  buildMilestoneCreateInputFromCli,
  buildMilestoneDeleteInputFromCli,
  buildMilestoneGetInput,
  buildMilestoneListInputFromCli,
  buildMilestoneUpdateInputFromCli,
  executeMilestoneCreate,
  executeMilestoneDelete,
  executeMilestoneGet,
  executeMilestoneList,
  executeMilestoneUpdate,
  milestoneListPayload,
} from "../surface/milestones.ts";

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
      const result = await executeMilestoneList(buildMilestoneListInputFromCli({ opts }));

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope(milestoneListPayload(result)), null, 2)}\n`,
        );
        return;
      }

      if (result.milestones.length === 0) {
        process.stdout.write("no milestones\n");
        return;
      }
      const nameWidth = Math.max(...result.milestones.map((m) => m.name.length));
      for (const m of result.milestones) {
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
      const milestone = await executeMilestoneGet(buildMilestoneGetInput(id));

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
    // validate that in the surface builder so the help text stays clean.
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
        const created = await executeMilestoneCreate(
          buildMilestoneCreateInputFromCli({ name, opts }),
        );
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
        const updated = await executeMilestoneUpdate(
          buildMilestoneUpdateInputFromCli({ id, opts }),
        );
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
      const r = await executeMilestoneDelete(buildMilestoneDeleteInputFromCli({ id, opts }));
      if (r.status === "deleted" && !r.success) process.exitCode = 1;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ id, status: r.status, success: r.success }), null, 2)}\n`,
        );
        return;
      }
      if (r.status === "already-absent") {
        process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(id)} (no-op)\n`);
      } else if (r.success) {
        process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(id)}\n`);
      } else {
        process.stdout.write(`${chalk.red("✗")} delete failed for ${id}\n`);
      }
    });
}
