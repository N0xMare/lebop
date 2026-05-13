import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { lookupStateByName, lookupUserByEmail } from "../lib/lookups.ts";

/**
 * `lebop lookup` — small read-only resolvers. State lookup is team-scoped
 * (workflow states are per-team in Linear); user lookup is workspace-scoped.
 * Both return null on miss with exit code 1 in human mode (so shell scripts
 * can `if lebop lookup user x@y.io > /dev/null; then ...`).
 */
export function registerLookup(program: Command): void {
  const cmd = program.command("lookup").description("resolve Linear names to UUIDs");

  cmd
    .command("state <team> <name>")
    .description("resolve a workflow state name to a UUID (team-scoped; case-sensitive)")
    .option("--json", "emit structured result")
    .action(async (team: string, name: string, opts: { json?: boolean }) => {
      const state = await lookupStateByName(team, name);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ state }), null, 2)}\n`);
        return;
      }
      if (!state) {
        process.stderr.write(`${chalk.red("not found:")} state "${name}" in team ${team}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `${chalk.bold(state.name)}  ${chalk.gray(state.type)}  ${chalk.gray(state.id)}\n`,
      );
    });

  cmd
    .command("user <email>")
    .description("resolve a workspace user by email")
    .option("--json", "emit structured result")
    .action(async (email: string, opts: { json?: boolean }) => {
      const user = await lookupUserByEmail(email);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ user }), null, 2)}\n`);
        return;
      }
      if (!user) {
        process.stderr.write(`${chalk.red("not found:")} user with email "${email}"\n`);
        process.exitCode = 1;
        return;
      }
      const inactive = user.active ? "" : chalk.gray(" [inactive]");
      const display = user.display_name ? chalk.gray(` (${user.display_name})`) : "";
      process.stdout.write(
        `${chalk.bold(user.name)}${display}  ${chalk.gray(user.email)}  ${chalk.gray(user.id)}${inactive}\n`,
      );
    });
}
