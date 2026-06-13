import chalk from "chalk";
import type { Command } from "commander";
import { invalidateTeamMetadata } from "../lib/cache.ts";
import { refreshCachedProjectAfterUpdate } from "../lib/cacheRefresh.ts";
import { findGitRoot, hashRepoRoot, resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { getTeamMetadata } from "../lib/resolve.ts";
import {
  buildProjectCreateInputFromCli,
  buildProjectDeleteInputFromCli,
  buildProjectGetInput,
  buildProjectListInputFromCli,
  buildProjectUpdateInputFromCli,
  executeProjectCreate,
  executeProjectDelete,
  executeProjectGet,
  executeProjectList,
  executeProjectUpdate,
  projectListPayload,
} from "../surface/projects.ts";

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
    .option("--include-archived", "include archived projects")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--cursor <token>", "continue from a previous JSON result's next_cursor")
    .option("--json", "emit structured records")
    .action(
      async (opts: {
        team?: string;
        allTeams?: boolean;
        state?: string;
        includeArchived?: boolean;
        limit?: string;
        cursor?: string;
        json?: boolean;
      }) => {
        const result = await executeProjectList(buildProjectListInputFromCli({ opts }), {
          resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
        });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope(projectListPayload(result)), null, 2)}\n`,
          );
          return;
        }

        if (result.records.length === 0) {
          process.stdout.write("no projects\n");
          return;
        }

        const stateWidth = Math.max(...result.records.map((r) => r.state.length));
        for (const r of result.records) {
          process.stdout.write(`[${r.state.padEnd(stateWidth)}]  ${r.name}\n`);
        }
        if (result.truncated) {
          process.stdout.write(
            `\nmore projects available; use --cursor ${result.next_cursor} with the same filters\n`,
          );
        }
      },
    );

  cmd
    .command("view <id>")
    .description("show one project by UUID")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const project = await executeProjectGet(
        buildProjectGetInput(id),
        "verify the project UUID; run `lebop projects` to discover ids",
      );

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ project }), null, 2)}\n`);
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
      if (project.icon) process.stdout.write(`  icon: ${chalk.cyan(project.icon)}\n`);
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
    .description("create a project (requires --team, --team-key, --team-id, or a default team)")
    .option("--team <key>", "team key (resolved to UUID via team metadata)")
    .option("--team-key <key>", "team key; repeat for multi-team projects", collectValues, [])
    .option("--team-id <uuid>", "team UUID; repeat for multi-team projects", collectValues, [])
    .option("--description <text>")
    .option("--content <text>", "long-form content body")
    .option("--icon <name>", "Linear internal icon name, e.g. BarChart or Rocket")
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
          teamKey?: string[];
          teamId?: string[];
          description?: string;
          content?: string;
          icon?: string;
          state?: string;
          startDate?: string;
          targetDate?: string;
          json?: boolean;
        },
      ) => {
        const { project: created, teamIds } = await executeProjectCreate(
          buildProjectCreateInputFromCli({ name, opts }),
          CLI_PROJECT_CREATE_TEAM_DEPS,
        );
        await invalidateTeamMetadata(currentRepoHash());

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope({ project: created, team_ids: teamIds }), null, 2)}\n`,
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
    .description("update a project (name, description, content, icon, state, dates)")
    .option("--name <text>")
    .option("--description <text>")
    .option("--content <text>")
    .option("--icon <name>", "Linear internal icon name, or `null` to clear")
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
          icon?: string;
          state?: string;
          startDate?: string;
          targetDate?: string;
          json?: boolean;
        },
      ) => {
        const {
          project: updated,
          cache,
          status,
        } = await executeProjectUpdate(buildProjectUpdateInputFromCli({ id, opts }), {
          refreshCache: refreshCachedProjectAfterUpdate,
        });
        await invalidateTeamMetadata(currentRepoHash());
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope({ status, project: updated, cache }), null, 2)}\n`,
          );
          if (cache.error) process.exitCode = 1;
          return;
        }
        process.stdout.write(
          `${cache.error ? chalk.red("✗") : chalk.green("✓")} updated ${chalk.bold(updated.name)} ${chalk.gray(`(${updated.id})`)}${cache.refreshed ? chalk.gray(" (cache refreshed)") : ""}${cache.error ? `  ${chalk.red(cache.error.message)}` : ""}\n`,
        );
        if (cache.error) process.exitCode = 1;
      },
    );

  cmd
    .command("delete <id>")
    .description("delete a project by UUID (irreversible — requires --yes)")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      const r = await executeProjectDelete(buildProjectDeleteInputFromCli({ id, opts }));
      if (r.status === "deleted") await invalidateTeamMetadata(currentRepoHash());
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

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function currentRepoHash(): string {
  const repoRoot = findGitRoot(process.cwd());
  return repoRoot ? hashRepoRoot(repoRoot) : "_global";
}

const CLI_PROJECT_CREATE_TEAM_DEPS = {
  defaultTeamKey: async (): Promise<string> => {
    const config = await resolveConfig();
    return config.team;
  },
  resolveTeamKeyToId: async (key: string): Promise<string> => {
    const config = await resolveConfig({ teamOverride: key });
    const md = await getTeamMetadata(config.repoHash, config.team);
    return md.team_id;
  },
};
