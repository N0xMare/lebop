import chalk from "chalk";
import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { listTeamMembers } from "../lib/teamMembers.ts";

/**
 * `lebop team` — team-scoped operations beyond listing. Currently only
 * `members` ships; team create/delete/autolinks are out-of-scope for
 * lebop (managed in the Linear UI). The plural `lebop teams` parent stays
 * as the canonical "list teams" verb.
 */
export function registerTeam(program: Command): void {
  const cmd = program.command("team").description("team-scoped operations");

  cmd
    .command("members [team-key]")
    .description("list members of a team (defaults to the resolved team)")
    .option("--all", "include inactive members")
    .option("--json", "emit structured records")
    .action(async (teamKey: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const config = await resolveConfig({ teamOverride: teamKey });
      const members = await listTeamMembers({
        teamKey: config.team,
        includeInactive: opts.all,
      });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              team: config.team,
              count: members.length,
              members,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (members.length === 0) {
        process.stdout.write(`no members in team ${config.team}\n`);
        return;
      }
      const nameWidth = Math.max(...members.map((m) => m.name.length));
      for (const m of members) {
        const owner = m.is_owner ? chalk.yellow(" (owner)") : "";
        const inactive = m.active ? "" : chalk.gray(" [inactive]");
        process.stdout.write(
          `${chalk.bold(m.name.padEnd(nameWidth))}  ${chalk.gray(m.email)}${owner}${inactive}\n`,
        );
      }
    });
}
