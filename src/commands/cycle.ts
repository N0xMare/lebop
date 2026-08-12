import chalk from "chalk";
import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { wantsMachineOutput } from "../lib/encode.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import { getTeam } from "../lib/teams.ts";
import {
  buildCycleArchiveInputFromCli,
  buildCycleCreateInputFromCli,
  buildCycleGetInput,
  buildCycleListInputFromCli,
  buildCycleUpdateInputFromCli,
  cycleListPayload,
  executeCycleArchive,
  executeCycleCreate,
  executeCycleGet,
  executeCycleList,
  executeCycleUpdate,
} from "../surface/cycles.ts";

const CYCLE_LIST_TEAM_NOT_FOUND_HINT =
  "use `lebop teams` to see available team keys, or pass --all-teams to skip team scoping";

const CYCLE_CREATE_TEAM_NOT_FOUND_HINT =
  "use `lebop teams` to see available team keys, or pass --team KEY";

/**
 * `lebop cycle list|view|create|update|archive` — team cycle (iteration) CRUD.
 * Issue assignment remains `set cycle` / update_issue.
 */
export function registerCycle(program: Command): void {
  const cmd = program.command("cycle").description("Linear cycles (iterations)");

  cmd
    .command("list")
    .description("list cycles for a team")
    .option("--team <key>", "override the resolved team")
    .option("--all-teams", "list cycles across all teams")
    .option("--include-archived", "include archived cycles (default: live only)")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (opts: {
        team?: string;
        allTeams?: boolean;
        includeArchived?: boolean;
        limit?: string;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      }) => {
        const result = await executeCycleList(buildCycleListInputFromCli({ opts }), {
          resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
          getTeam,
          teamNotFoundHint: CYCLE_LIST_TEAM_NOT_FOUND_HINT,
        });

        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            {
              ...cycleListPayload(result),
              next: ["cycle view <id>", "list --cycle <name-or-id>", "set cycle <id> <name>"],
            } as Record<string, unknown>,
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
          return;
        }

        if (result.cycles.length === 0) {
          process.stdout.write("no cycles\n");
          return;
        }
        for (const c of result.cycles) {
          const name = c.name ?? `Cycle ${c.number}`;
          const when = `${chalk.gray(c.starts_at.slice(0, 10))} → ${chalk.gray(c.ends_at.slice(0, 10))}`;
          const flags: string[] = [];
          if (c.is_active) flags.push(chalk.green("active"));
          if (c.is_next) flags.push(chalk.cyan("next"));
          if (c.is_previous) flags.push(chalk.gray("previous"));
          if (c.completed_at) flags.push(chalk.green("completed"));
          if (c.archived_at) flags.push(chalk.gray("archived"));
          const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
          process.stdout.write(
            `${chalk.bold(`#${c.number}`)} ${chalk.cyan(c.team.key)} ${name}  ${when}${flagStr}\n`,
          );
        }
      },
    );

  cmd
    .command("view <id>")
    .description("show one cycle by UUID")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(async (id: string, opts: { json?: boolean; format?: string; pretty?: boolean }) => {
      const cycle = await executeCycleGet(buildCycleGetInput(id));

      if (wantsMachineOutput(opts)) {
        writeMachineEnvelope(
          {
            cycle,
            next: ["list --cycle <name-or-id>", "set cycle <id> <name>", "cycle list"],
          },
          {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          },
        );
        return;
      }
      const name = cycle.name ?? `Cycle ${cycle.number}`;
      process.stdout.write(`${chalk.bold(name)} ${chalk.gray(`(${cycle.team.key})`)}\n`);
      process.stdout.write(`  number: ${cycle.number}\n`);
      process.stdout.write(`  starts: ${cycle.starts_at}\n`);
      process.stdout.write(`  ends: ${cycle.ends_at}\n`);
      if (cycle.description) process.stdout.write(`  description: ${cycle.description}\n`);
      const status = [
        cycle.is_active && "active",
        cycle.is_next && "next",
        cycle.is_previous && "previous",
        cycle.is_past && "past",
        cycle.is_future && "future",
      ]
        .filter(Boolean)
        .join(", ");
      if (status) process.stdout.write(`  status: ${status}\n`);
      if (cycle.completed_at) process.stdout.write(`  completed: ${cycle.completed_at}\n`);
      if (cycle.archived_at) process.stdout.write(`  archived: ${cycle.archived_at}\n`);
    });

  cmd
    .command("create")
    .description("create a team cycle (ISO DateTime starts/ends; number is server-assigned)")
    .option("--team <key>", "team key (default: configured team)")
    .requiredOption("--starts <iso>", "start ISO DateTime (e.g. 2026-09-01T00:00:00.000Z)")
    .requiredOption("--ends <iso>", "end ISO DateTime (e.g. 2026-09-14T23:59:59.999Z)")
    .option("--name <text>", "optional custom name")
    .option("--description <text>", "optional description")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (opts: {
        team?: string;
        starts: string;
        ends: string;
        name?: string;
        description?: string;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      }) => {
        const created = await executeCycleCreate(buildCycleCreateInputFromCli({ opts }), {
          resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
          teamNotFoundHint: CYCLE_CREATE_TEAM_NOT_FOUND_HINT,
        });
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ cycle: created } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        const label = created.name ?? `Cycle ${created.number}`;
        process.stdout.write(
          `${chalk.green("✓")} created ${chalk.bold(label)} #${created.number} ${chalk.gray(`(${created.id})`)} on ${chalk.cyan(created.team.key)}\n`,
        );
      },
    );

  cmd
    .command("update <id>")
    .description("update a cycle (name, description, starts, ends, completed-at)")
    .option("--name <text>")
    .option("--description <text>", "or `null` to clear")
    .option("--starts <iso>", "start ISO DateTime")
    .option("--ends <iso>", "end ISO DateTime")
    .option("--completed-at <iso>", "ISO DateTime to mark complete, or `null` to clear")
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
          starts?: string;
          ends?: string;
          completedAt?: string;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const updated = await executeCycleUpdate(buildCycleUpdateInputFromCli({ id, opts }));
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ cycle: updated } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        const label = updated.name ?? `Cycle ${updated.number}`;
        process.stdout.write(
          `${chalk.green("✓")} updated ${chalk.bold(label)} ${chalk.gray(`(${updated.id})`)}\n`,
        );
      },
    );

  cmd
    .command("archive <id>")
    .description(
      "archive a cycle (unlinks issues on the cycle first; no unarchive — requires --yes)",
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
        const result = await executeCycleArchive(buildCycleArchiveInputFromCli({ id, opts }));
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            { id: result.id, success: result.success } as Record<string, unknown>,
            { json: true, format: opts.format, pretty: opts.pretty },
          );
          return;
        }
        if (result.success) {
          process.stdout.write(`${chalk.green("✓")} archived ${chalk.bold(result.id)}\n`);
        } else {
          process.exitCode = 1;
          process.stdout.write(`${chalk.red("✗")} archive failed for ${id}\n`);
        }
      },
    );
}
