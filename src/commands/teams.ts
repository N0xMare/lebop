import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { addMachineOutputOptions, writeMachineEnvelope } from "../lib/output.ts";
import { buildTeamListInputFromCli, executeTeamList, teamListPayload } from "../surface/teams.ts";

export function registerTeams(program: Command): void {
  const cmd = program.command("teams").description("list teams in the workspace");
  addMachineOutputOptions(cmd);
  cmd.action(async (opts: { json?: boolean; format?: string; pretty?: boolean }) => {
    const result = await executeTeamList(buildTeamListInputFromCli());
    const records = result.teams;

    if (wantsMachineOutput(opts)) {
      writeMachineEnvelope(
        {
          ...teamListPayload(result),
          next: ["team members", "team view <key>", "list --team <key>"],
        } as Record<string, unknown>,
        {
          json: true,
          format: opts.format,
          pretty: opts.pretty,
        },
      );
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
