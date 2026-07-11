import chalk from "chalk";
import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { getTeam } from "../lib/teams.ts";
import {
  buildCycleGetInput,
  buildCycleListInputFromCli,
  cycleListPayload,
  executeCycleGet,
  executeCycleList,
} from "../surface/cycles.ts";

const CYCLE_LIST_TEAM_NOT_FOUND_HINT =
  "use `lebop teams` to see available team keys, or pass --all-teams to skip team scoping";

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
      const result = await executeCycleList(buildCycleListInputFromCli({ opts }), {
        resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
        getTeam,
        teamNotFoundHint: CYCLE_LIST_TEAM_NOT_FOUND_HINT,
      });

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(cycleListPayload(result)), null, 2)}\n`);
        return;
      }

      if (result.cycles.length === 0) {
        process.stdout.write("no cycles\n");
        return;
      }
      for (const c of result.cycles) {
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
      const cycle = await executeCycleGet(buildCycleGetInput(id));

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
