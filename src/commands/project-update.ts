import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { resolveBody } from "../lib/io.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import {
  buildProjectUpdateCreateInputFromCli,
  buildProjectUpdateDeleteInputFromCli,
  buildProjectUpdateListInputFromCli,
  buildProjectUpdateUpdateInputFromCli,
  executeProjectUpdateCreate,
  executeProjectUpdateDelete,
  executeProjectUpdateList,
  executeProjectUpdateUpdate,
  projectUpdateListPayload,
} from "../surface/project-updates.ts";

/**
 * `lebop project-update create|list` — manage project status updates with
 * --health (onTrack / atRisk / offTrack). Mirrors linear-cli's
 * `linear project-update`.
 */
export function registerProjectUpdate(program: Command): void {
  const cmd = program
    .command("project-update")
    .description("manage project status updates (with health)");

  cmd
    .command("create <project>")
    .description("post a project update; project is name or UUID")
    .option("--body <text>", "update body (inline)")
    .option("--body-file <path>", "read body from a file")
    .option("--stdin", "read body from stdin")
    .option("--health <state>", "onTrack | atRisk | offTrack")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        project: string,
        opts: {
          body?: string;
          bodyFile?: string;
          stdin?: boolean;
          health?: string;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const body = await resolveBody(opts);
        const result = await executeProjectUpdateCreate(
          buildProjectUpdateCreateInputFromCli({ project, body, health: opts.health }),
        );

        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            { project_update: result.project_update } as Record<string, unknown>,
            { json: true, format: opts.format, pretty: opts.pretty },
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} posted update on project ${chalk.gray(result.project_id)}${result.project_update.health ? `  ${chalk.cyan(result.project_update.health)}` : ""}\n`,
        );
      },
    );

  cmd
    .command("list <project>")
    .description("list status updates on a project (project is name or UUID)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (project: string, opts: { json?: boolean; format?: string; pretty?: boolean }) => {
        const result = await executeProjectUpdateList(
          buildProjectUpdateListInputFromCli({ project }),
        );
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            {
              ...projectUpdateListPayload(result),
              next: ["project-update create <project>", "project view <id>"],
            } as Record<string, unknown>,
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
          return;
        }

        if (result.updates.length === 0) {
          process.stdout.write("no updates\n");
          return;
        }
        for (const u of result.updates) {
          const health = u.health ? `  ${chalk.cyan(u.health)}` : "";
          const who = u.user ? `${u.user.name} <${u.user.email}>` : "unknown";
          process.stdout.write(
            `\n${chalk.dim(u.created_at)}  ${chalk.bold(who)}${health}  ${chalk.gray(u.id)}\n${u.body}\n`,
          );
        }
      },
    );

  cmd
    .command("update <id>")
    .description("edit a project status update by UUID")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--stdin", "read body from stdin")
    .option("--health <state>", "onTrack | atRisk | offTrack")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        id: string,
        opts: {
          body?: string;
          bodyFile?: string;
          stdin?: boolean;
          health?: string;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const body =
          opts.body !== undefined || opts.bodyFile || opts.stdin
            ? await resolveBody(opts)
            : undefined;
        const project_update = await executeProjectUpdateUpdate(
          buildProjectUpdateUpdateInputFromCli({
            id,
            body,
            health: opts.health,
          }),
        );
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ project_update } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated project update ${chalk.gray(project_update.id)}\n`,
        );
      },
    );

  cmd
    .command("soft-delete <id>")
    .description("archive (soft-delete) a project status update by UUID")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        id: string,
        opts: { yes?: boolean; json?: boolean; format?: string; pretty?: boolean },
      ) => {
        const result = await executeProjectUpdateDelete(
          buildProjectUpdateDeleteInputFromCli({ id, opts }),
        );
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(result as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        if (result.status === "already-absent") {
          process.stdout.write(
            `${chalk.gray("·")} project update ${chalk.gray(result.id)} already absent\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} deleted project update ${chalk.gray(result.id)}\n`,
        );
      },
    );
}
