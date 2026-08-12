import type { Command } from "commander";
import { addMachineOutputOptions, writeMachineEnvelope } from "../lib/output.ts";
import { buildSearchLinearInputFromCli, executeSearchLinear } from "../surface/coverage.ts";

export function registerSearch(program: Command): void {
  const cmd = program
    .command("search")
    .description("Linear hybrid/semantic search (falls back to keyword issue search)")
    .requiredOption("--query <text>", "search text")
    .option("--limit <n>", "max hits (default 20)", "20");
  addMachineOutputOptions(cmd);
  cmd.action(
    async (opts: {
      query: string;
      limit?: string;
      json?: boolean;
      format?: string;
      pretty?: boolean;
    }) => {
      const result = await executeSearchLinear(buildSearchLinearInputFromCli({ opts }));
      writeMachineEnvelope(
        {
          query: result.query,
          count: result.count,
          hits: result.hits,
          next: result.next,
        },
        { json: true, format: opts.format, pretty: opts.pretty },
      );
    },
  );
}
