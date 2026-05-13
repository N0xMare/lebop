import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { paginateConnection } from "../lib/paginate.ts";
import { linear } from "../lib/sdk.ts";

export function registerTeams(program: Command): void {
  program
    .command("teams")
    .description("list teams in the workspace")
    .option("--json", "emit structured team records")
    .action(async (opts: { json?: boolean }) => {
      const client = await linear();
      const teams = await paginateConnection(({ first, after }) => client.teams({ first, after }));
      const records = teams.map((t) => ({
        key: t.key,
        name: t.name,
        id: t.id,
        description: t.description ?? null,
      }));

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ teams: records }), null, 2)}\n`);
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
