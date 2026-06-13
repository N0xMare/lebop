import chalk from "chalk";
import type { Command } from "commander";
import { parseCliLimit } from "../lib/cliOptions.ts";
import { resolveConfig } from "../lib/config.ts";
import { getCycle, listCycles } from "../lib/cycles.ts";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError } from "../lib/errors.ts";
import { getTeam } from "../lib/teams.ts";

export function registerCycle(program: Command): void {
  const cmd = program.command("cycle").description("Linear cycles (iterations)");

  cmd
    .command("list")
    .description("list cycles for a team")
    .option("--team <key>", "override the resolved team")
    .option("--all-teams", "list cycles across all teams")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured records")
    .action(async (opts: { team?: string; allTeams?: boolean; limit?: string; json?: boolean }) => {
      const team = opts.allTeams
        ? undefined
        : (await resolveConfig({ teamOverride: opts.team })).team;
      if (!opts.allTeams && team) {
        const resolvedTeam = await getTeam(team);
        if (!resolvedTeam) {
          throw new NotFoundError(
            `team not found: ${team}`,
            "use `lebop teams` to see available team keys, or pass --all-teams to skip team scoping",
          );
        }
      }
      const max = parseCliLimit(opts.limit, { defaultValue: 50, zeroMeansInfinity: true });
      const cycles = await listCycles({
        team,
        max,
      });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              team: opts.allTeams ? "*" : team,
              count: cycles.length,
              cycles,
            }),
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (cycles.length === 0) {
        process.stdout.write("no cycles\n");
        return;
      }
      for (const c of cycles) {
        const name = c.name ?? `Cycle ${c.number}`;
        const when = `${chalk.gray(c.starts_at.slice(0, 10))} → ${chalk.gray(c.ends_at.slice(0, 10))}`;
        const completed = c.completed_at ? chalk.green(" [completed]") : "";
        const archived = c.archived_at ? chalk.gray(" [archived]") : "";
        process.stdout.write(
          `${chalk.bold(`#${c.number}`)} ${chalk.cyan(c.team.key)} ${name}  ${when}${completed}${archived}\n`,
        );
      }
    });

  cmd
    .command("view <id>")
    .description("show one cycle by UUID")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cycle = await getCycle(id);
      if (!cycle) throw new NotFoundError(`cycle not found: ${id}`);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ cycle }), null, 2)}\n`);
        return;
      }
      const name = cycle.name ?? `Cycle ${cycle.number}`;
      process.stdout.write(`${chalk.bold(name)} ${chalk.gray(`(${cycle.team.key})`)}\n`);
      process.stdout.write(`  starts: ${cycle.starts_at}\n`);
      process.stdout.write(`  ends: ${cycle.ends_at}\n`);
      if (cycle.completed_at) process.stdout.write(`  completed: ${cycle.completed_at}\n`);
      if (cycle.archived_at) process.stdout.write(`  archived: ${cycle.archived_at}\n`);
    });
}
