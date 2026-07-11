import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import {
  buildTeamGetInputFromCli,
  buildTeamMembersListInputFromCli,
  buildWorkflowStatesListInputFromCli,
  executeTeamGet,
  executeTeamMembersList,
  executeWorkflowStatesList,
  teamMembersListPayload,
  workflowStatesListPayload,
} from "../surface/teams.ts";

const TEAM_GET_NOT_FOUND_HINT = "run `lebop teams` to list valid team keys";
const WORKFLOW_STATES_TEAM_NOT_FOUND_HINT = "run `lebop teams` to list valid team keys";

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
    .description(
      "list members of a team. Pass the team key as a POSITIONAL arg (e.g. `lebop team members NOX`); the top-level `--team` / `LEBOP_TEAM` env / config default also resolve when the positional is omitted. There is no `--team-key` flag.",
    )
    .option("--all", "include inactive members")
    .option("--json", "emit structured records")
    .action(async (teamKey: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const result = await executeTeamMembersList(
        buildTeamMembersListInputFromCli({ teamKey, opts }),
      );

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope(teamMembersListPayload(result)), null, 2)}\n`,
        );
        return;
      }

      if (result.members.length === 0) {
        process.stdout.write(`no members in team ${result.team}\n`);
        return;
      }
      const nameWidth = Math.max(...result.members.map((m) => m.name.length));
      for (const m of result.members) {
        const owner = m.is_owner ? chalk.yellow(" (owner)") : "";
        const inactive = m.active ? "" : chalk.gray(" [inactive]");
        process.stdout.write(
          `${chalk.bold(m.name.padEnd(nameWidth))}  ${chalk.gray(m.email)}${owner}${inactive}\n`,
        );
      }
    });

  cmd
    .command("get <key-or-id>")
    .description("show one team by key (e.g. NOX) or UUID")
    .option("--json", "emit structured result")
    .action(async (keyOrId: string, opts: { json?: boolean }) => {
      const team = await executeTeamGet(
        buildTeamGetInputFromCli({ keyOrId }),
        TEAM_GET_NOT_FOUND_HINT,
      );
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ team }), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${chalk.bold(team.key)}  ${team.name}\n  id: ${chalk.gray(team.id)}\n`);
      if (team.description) process.stdout.write(`  description: ${team.description}\n`);
      if (team.default_state_name)
        process.stdout.write(
          `  default state: ${team.default_state_name} ${chalk.gray(`(${team.default_state_id})`)}\n`,
        );
    });

  cmd
    .command("workflow-states [team-key]")
    .description("list workflow states (Backlog, Todo, In Progress, ...) for a team")
    .option("--json", "emit structured records")
    .action(async (teamKey: string | undefined, opts: { json?: boolean }) => {
      const result = await executeWorkflowStatesList(
        buildWorkflowStatesListInputFromCli({ teamKey }),
        { teamNotFoundHint: WORKFLOW_STATES_TEAM_NOT_FOUND_HINT },
      );
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope(workflowStatesListPayload(result)), null, 2)}\n`,
        );
        return;
      }
      const nameWidth = Math.max(...result.states.map((s) => s.name.length));
      for (const st of result.states) {
        const mark = st.default ? chalk.green(" *") : "  ";
        process.stdout.write(
          `${mark} ${chalk.bold(st.name.padEnd(nameWidth))}  ${chalk.gray(st.type)}\n`,
        );
      }
    });
}
