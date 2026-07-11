import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { resolveBody } from "../lib/io.ts";
import {
  buildProjectUpdateCreateInputFromCli,
  buildProjectUpdateListInputFromCli,
  executeProjectUpdateCreate,
  executeProjectUpdateList,
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
    .option("--json", "emit structured result")
    .action(
      async (
        project: string,
        opts: {
          body?: string;
          bodyFile?: string;
          stdin?: boolean;
          health?: string;
          json?: boolean;
        },
      ) => {
        const body = await resolveBody(opts);
        const result = await executeProjectUpdateCreate(
          buildProjectUpdateCreateInputFromCli({ project, body, health: opts.health }),
        );

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope({ project_update: result.project_update }), null, 2)}\n`,
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
    .option("--json", "emit structured records")
    .action(async (project: string, opts: { json?: boolean }) => {
      const result = await executeProjectUpdateList(
        buildProjectUpdateListInputFromCli({ project }),
      );
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope(projectUpdateListPayload(result)), null, 2)}\n`,
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
    });
}
