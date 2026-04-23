import type { Command } from "commander";
import { linear } from "../lib/sdk.ts";

export function registerTeams(program: Command): void {
  program
    .command("teams")
    .description("list teams in the workspace")
    .option("--json", "emit structured team records")
    .action(async (opts: { json?: boolean }) => {
      const client = await linear();
      const teams = await client.teams({ first: 250 });
      const records = teams.nodes.map((t) => ({
        key: t.key,
        name: t.name,
        id: t.id,
        description: t.description ?? null,
      }));

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, teams: records }, null, 2)}\n`);
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
