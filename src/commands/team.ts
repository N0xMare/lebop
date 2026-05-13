import chalk from "chalk";
import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError } from "../lib/errors.ts";
import { listTeamMembers } from "../lib/teamMembers.ts";
import { getTeam } from "../lib/teams.ts";
import { listWorkflowStates } from "../lib/workflowStates.ts";

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
      const config = await resolveConfig({ teamOverride: teamKey });
      const members = await listTeamMembers({
        teamKey: config.team,
        includeInactive: opts.all,
      });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              team: config.team,
              count: members.length,
              members,
            }),
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

  cmd
    .command("get <key-or-id>")
    .description("show one team by key (e.g. NOX) or UUID")
    .option("--json", "emit structured result")
    .action(async (keyOrId: string, opts: { json?: boolean }) => {
      const team = await getTeam(keyOrId);
      // Round-13 / L-1: align miss-contract with sibling `view`/`get`
      // commands (`document view`, `milestone view`, `initiative view`,
      // `agent-session view`). Throw NotFoundError BEFORE the --json branch
      // so both modes emit the structured envelope / `code: "not_found"`
      // exit-1 shape. Pre-fix `--json` returned `{team: null}` (mirroring
      // MCP `get_team` null contract) while human mode wrote stderr + exit
      // 1 — surface-inconsistent.
      if (!team)
        throw new NotFoundError(
          `team not found: ${keyOrId}`,
          "run `lebop teams` to list valid team keys",
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
      const config = await resolveConfig({ teamOverride: teamKey });
      const result = await listWorkflowStates(config.team);
      if (!result) {
        // Round-11 / N-2: throw structured NotFoundError so `--json` mode
        // emits the proper `{ok:false, error:{code:"not_found", ...}}`
        // envelope (parity with `agent-session view`, `show`, etc.).
        // Pre-fix this wrote chalk prose to stderr even under `--json`,
        // violating the spec's "CLI --json errors emit structured envelope"
        // commitment (round-7 / Q4).
        throw new NotFoundError(
          `team not found: ${config.team}`,
          "run `lebop teams` to list valid team keys",
        );
      }
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({ team: result.team, count: result.states.length, states: result.states }),
            null,
            2,
          )}\n`,
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
