import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import {
  buildLookupStateByNameInputFromCli,
  buildLookupUserByEmailInputFromCli,
  executeLookupStateByName,
  executeLookupUserByEmail,
  lookupStateByNamePayload,
  lookupUserByEmailPayload,
} from "../surface/lookups.ts";

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
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        team: string,
        name: string,
        opts: { json?: boolean; format?: string; pretty?: boolean },
      ) => {
        const result = await executeLookupStateByName(
          buildLookupStateByNameInputFromCli({ team, name }),
        );
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(lookupStateByNamePayload(result) as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        if (!result.state) {
          process.stderr.write(`${chalk.red("not found:")} state "${name}" in team ${team}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          `${chalk.bold(result.state.name)}  ${chalk.gray(result.state.type)}  ${chalk.gray(result.state.id)}\n`,
        );
      },
    );

  cmd
    .command("user <email>")
    .description("resolve a workspace user by email")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(async (email: string, opts: { json?: boolean; format?: string; pretty?: boolean }) => {
      const result = await executeLookupUserByEmail(buildLookupUserByEmailInputFromCli({ email }));
      if (wantsMachineOutput(opts)) {
        writeMachineEnvelope(lookupUserByEmailPayload(result) as Record<string, unknown>, {
          json: true,
          format: opts.format,
          pretty: opts.pretty,
        });
        return;
      }
      if (!result.user) {
        process.stderr.write(`${chalk.red("not found:")} user with email "${email}"\n`);
        process.exitCode = 1;
        return;
      }
      const inactive = result.user.active ? "" : chalk.gray(" [inactive]");
      const display = result.user.display_name ? chalk.gray(` (${result.user.display_name})`) : "";
      process.stdout.write(
        `${chalk.bold(result.user.name)}${display}  ${chalk.gray(result.user.email)}  ${chalk.gray(result.user.id)}${inactive}\n`,
      );
    });
}
