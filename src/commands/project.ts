import chalk from "chalk";
import type { Command } from "commander";
import { invalidateTeamMetadata } from "../lib/cache.ts";
import { refreshCachedProjectAfterUpdate } from "../lib/cacheRefresh.ts";
import { findGitRoot, hashRepoRoot, resolveConfig } from "../lib/config.ts";
import { wantsMachineOutput } from "../lib/encode.ts";
import { listNext } from "../lib/nextStubs.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
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
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (opts: {
        team?: string;
        allTeams?: boolean;
        state?: string;
        includeArchived?: boolean;
        limit?: string;
        cursor?: string;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      }) => {
        const result = await executeProjectList(buildProjectListInputFromCli({ opts }), {
          resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
        });

        if (wantsMachineOutput(opts)) {
          const body = projectListPayload(result);
          writeMachineEnvelope(
            {
              ...body,
              next: listNext(Boolean(body.has_more), body.next_cursor, {
                show: "project view <id>",
                extra: ["list --project <name>"],
              }),
            } as Record<string, unknown>,
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
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
    .description("show one project by UUID (content/description size-capped for agents)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .option("--full-content", "full project content on the wire (bypass 64 KiB cap)")
    .option(
      "--content-file <path>",
      "write full project content to path (host FS); wire stays dense",
    )
    .action(
      async (
        id: string,
        opts: {
          json?: boolean;
          format?: string;
          pretty?: boolean;
          fullContent?: boolean;
          contentFile?: string;
        },
      ) => {
        const fullForHuman = !wantsMachineOutput(opts);
        const { project, content, truncated } = await executeProjectGet(
          buildProjectGetInput(id, {
            fullContent: opts.fullContent === true || fullForHuman,
            contentFile: opts.contentFile,
          }),
          "verify the project UUID; run `lebop projects` to discover ids",
        );

        if (wantsMachineOutput(opts)) {
          const next = truncated
            ? [
                `project view ${id} --content-file ./content.md`,
                `project view ${id} --full-content`,
              ]
            : [
                "list --project <name>",
                "milestone list --project <id>",
                "project-update list <id>",
              ];
          writeMachineEnvelope(
            {
              project,
              content,
              next,
            } as Record<string, unknown>,
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
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
        // chalk path uses project body after content policy (full when --human via fullForHuman)
        const desc = project.description as string | null | undefined;
        const body = project.content as string | null | undefined;
        if (desc) process.stdout.write(`\n${desc}\n`);
        if (body) process.stdout.write(`\n${chalk.gray("── content ──")}\n${body}\n`);
      },
    );

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
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
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
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const { project: created, teamIds } = await executeProjectCreate(
          buildProjectCreateInputFromCli({ name, opts }),
          CLI_PROJECT_CREATE_TEAM_DEPS,
        );
        await invalidateTeamMetadata(currentRepoHash());

        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ project: created, team_ids: teamIds } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
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
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
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
          format?: string;
          pretty?: boolean;
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
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ status, project: updated, cache } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
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
    .command("soft-delete <id>")
    .description(
      "soft-delete a project (sets archived_at; not restored by lebop unarchive — requires --yes)",
    )
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
        const r = await executeProjectDelete(buildProjectDeleteInputFromCli({ id, opts }));
        if (r.status === "deleted") await invalidateTeamMetadata(currentRepoHash());
        if (r.status === "deleted" && !r.success) process.exitCode = 1;
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            { id, status: r.status, success: r.success } as Record<string, unknown>,
            { json: true, format: opts.format, pretty: opts.pretty },
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
      },
    );
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
