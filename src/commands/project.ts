import chalk from "chalk";
import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "../lib/projects.ts";
import { getTeamMetadata } from "../lib/resolve.ts";

/**
 * `lebop project list|view|create|update|delete` — full CRUD over Linear
 * projects. Replaces the earlier `lebop projects` (plural, list-only)
 * command surface with a richer parent that mirrors linear-cli's shape.
 */
export function registerProject(program: Command): void {
  const cmd = program.command("project").description("manage Linear projects");

  cmd
    .command("list")
    .description("list projects in the current team (default) or workspace")
    .option("--team <key>", "override the resolved team")
    .option("--all-teams", "list every project the token can see (no team filter)")
    .option("--state <name>", "filter: backlog | planned | started | paused | completed | canceled")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured records")
    .action(
      async (opts: {
        team?: string;
        allTeams?: boolean;
        state?: string;
        limit?: string;
        json?: boolean;
      }) => {
        const config = await resolveConfig({ teamOverride: opts.team });
        const requested = Number.parseInt(opts.limit ?? "50", 10);
        const max = requested === 0 ? Number.POSITIVE_INFINITY : Math.max(1, requested);
        const records = await listProjects({
          team: opts.allTeams ? undefined : config.team,
          state: opts.state,
          max,
        });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                schema_version: 1,
                team: opts.allTeams ? "*" : config.team,
                count: records.length,
                projects: records,
              },
              null,
              2,
            )}\n`,
          );
          return;
        }

        if (records.length === 0) {
          process.stdout.write("no projects\n");
          return;
        }

        const stateWidth = Math.max(...records.map((r) => r.state.length));
        for (const r of records) {
          process.stdout.write(`[${r.state.padEnd(stateWidth)}]  ${r.name}\n`);
        }
      },
    );

  cmd
    .command("view <id>")
    .description("show one project by UUID")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const project = await getProject(id);
      if (!project) throw new Error(`project not found: ${id}`);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, project }, null, 2)}\n`);
        return;
      }

      process.stdout.write(`${chalk.bold(project.name)}\n`);
      process.stdout.write(`  state: ${chalk.cyan(project.state)}\n`);
      if (project.lead) {
        process.stdout.write(`  lead: ${project.lead.name} <${project.lead.email}>\n`);
      }
      if (project.teams.length > 0) {
        process.stdout.write(
          `  teams: ${project.teams.map((t) => `${t.key} (${t.name})`).join(", ")}\n`,
        );
      }
      if (project.start_date) process.stdout.write(`  start: ${project.start_date}\n`);
      if (project.target_date) process.stdout.write(`  target: ${project.target_date}\n`);
      process.stdout.write(`  url: ${chalk.gray(project.url)}\n`);
      if (project.description) {
        process.stdout.write(`\n${project.description}\n`);
      }
      if (project.content) {
        process.stdout.write(`\n${chalk.gray("── content ──")}\n${project.content}\n`);
      }
    });

  cmd
    .command("create <name>")
    .description("create a project (requires --team or --team-id)")
    .option("--team <key>", "team key (resolved to UUID via team metadata)")
    .option("--team-id <uuid>", "team UUID (skip the metadata lookup)")
    .option("--description <text>")
    .option("--content <text>", "long-form content body")
    .option(
      "--state <name>",
      "backlog (default) | planned | started | paused | completed | canceled",
    )
    .option("--start-date <iso>")
    .option("--target-date <iso>")
    .option("--json", "emit structured result")
    .action(
      async (
        name: string,
        opts: {
          team?: string;
          teamId?: string;
          description?: string;
          content?: string;
          state?: string;
          startDate?: string;
          targetDate?: string;
          json?: boolean;
        },
      ) => {
        let teamId = opts.teamId;
        if (!teamId) {
          const config = await resolveConfig({ teamOverride: opts.team });
          const md = await getTeamMetadata(config.repoHash, config.team);
          teamId = md.team_id;
        }

        const created = await createProject({
          name,
          teamIds: [teamId],
          description: opts.description,
          content: opts.content,
          state: opts.state,
          startDate: opts.startDate,
          targetDate: opts.targetDate,
        });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ schema_version: 1, project: created }, null, 2)}\n`,
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
    .description("update a project (name, description, content, state, dates)")
    .option("--name <text>")
    .option("--description <text>")
    .option("--content <text>")
    .option("--state <name>")
    .option("--start-date <iso>", "or `null` to clear")
    .option("--target-date <iso>", "or `null` to clear")
    .option("--json", "emit structured result")
    .action(
      async (
        id: string,
        opts: {
          name?: string;
          description?: string;
          content?: string;
          state?: string;
          startDate?: string;
          targetDate?: string;
          json?: boolean;
        },
      ) => {
        const input: Parameters<typeof updateProject>[1] = {};
        if (opts.name !== undefined) input.name = opts.name;
        if (opts.description !== undefined) input.description = opts.description;
        if (opts.content !== undefined) input.content = opts.content;
        if (opts.state !== undefined) input.state = opts.state;
        if (opts.startDate !== undefined) {
          input.startDate = opts.startDate === "null" ? null : opts.startDate;
        }
        if (opts.targetDate !== undefined) {
          input.targetDate = opts.targetDate === "null" ? null : opts.targetDate;
        }

        if (Object.keys(input).length === 0) {
          throw new Error(
            "nothing to update — pass at least one of --name / --description / --content / --state / --start-date / --target-date",
          );
        }

        const updated = await updateProject(id, input);
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ schema_version: 1, project: updated }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated ${chalk.bold(updated.name)} ${chalk.gray(`(${updated.id})`)}\n`,
        );
      },
    );

  cmd
    .command("delete <id>")
    .description("delete a project by UUID (irreversible)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const success = await deleteProject(id);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, id, success }, null, 2)}\n`);
        return;
      }
      if (success) {
        process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(id)}\n`);
      } else {
        process.stdout.write(`${chalk.red("✗")} delete failed for ${id}\n`);
        process.exitCode = 1;
      }
    });
}
