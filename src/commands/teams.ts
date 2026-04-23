import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerTeams(program: Command): void {
  program
    .command("teams")
    .description("list teams in the workspace")
    .option("--json", "emit structured team records")
    .action(() => notImplemented("leebop teams", "Phase 1"));
}
