import chalk from "chalk";
import type { Command } from "commander";
import { resolveBody } from "../lib/io.ts";
import { resolveProjectId } from "../lib/milestones.ts";
import { createProjectUpdate, listProjectUpdates, type ProjectHealth } from "../lib/projects.ts";

const HEALTH_VALUES = ["onTrack", "atRisk", "offTrack"] as const;

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
        const projectId = await resolveProjectId(project);
        if (!projectId) throw new Error(`project not found: ${project}`);

        const body = await resolveBody(opts);
        if (!body.trim()) throw new Error("empty update body");

        let health: ProjectHealth | undefined;
        if (opts.health) {
          if (!(HEALTH_VALUES as readonly string[]).includes(opts.health)) {
            throw new Error(
              `invalid --health "${opts.health}". expected: ${HEALTH_VALUES.join(", ")}`,
            );
          }
          health = opts.health as ProjectHealth;
        }

        const created = await createProjectUpdate({ projectId, body, health });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ schema_version: 1, project_update: created }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} posted update on project ${chalk.gray(projectId)}${health ? `  ${chalk.cyan(health)}` : ""}\n`,
        );
      },
    );

  cmd
    .command("list <project>")
    .description("list status updates on a project (project is name or UUID)")
    .option("--json", "emit structured records")
    .action(async (project: string, opts: { json?: boolean }) => {
      const projectId = await resolveProjectId(project);
      if (!projectId) throw new Error(`project not found: ${project}`);

      const updates = await listProjectUpdates(projectId);
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              project_id: projectId,
              count: updates.length,
              updates,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (updates.length === 0) {
        process.stdout.write("no updates\n");
        return;
      }
      for (const u of updates) {
        const health = u.health ? `  ${chalk.cyan(u.health)}` : "";
        const who = u.user ? `${u.user.name} <${u.user.email}>` : "unknown";
        process.stdout.write(
          `\n${chalk.dim(u.created_at)}  ${chalk.bold(who)}${health}  ${chalk.gray(u.id)}\n${u.body}\n`,
        );
      }
    });
}
