import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { buildTeamListInputFromCli, executeTeamList, teamListPayload } from "../surface/teams.ts";

export function registerTeams(program: Command): void {
  program
    .command("teams")
    .description("list teams in the workspace")
    .option("--json", "emit structured team records")
    .action(async (opts: { json?: boolean }) => {
      const result = await executeTeamList(buildTeamListInputFromCli());
      const records = result.teams;

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(teamListPayload(result)), null, 2)}\n`);
        return;
      }

      if (records.length === 0) {
        process.stdout.write("no teams accessible with the stored token\n");
        return;
      }
      const keyWidth = Math.max(...records.map((r) => r.key.length));
      for (const r of records) {
        process.stdout.write(`${r.key.padEnd(keyWidth)}  ${r.name}\n`);
      }
    });
}
