import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerRaw(program: Command): void {
  program
    .command("raw <query>")
    .description("GraphQL escape hatch — run an arbitrary query/mutation against Linear")
    .option("--variables-json <path>", "read variables from a JSON file (or '-' for stdin)")
    .option("--json", "pretty-print the response (default)")
    .action(() => notImplemented("leebop raw", "Phase 1"));
}
