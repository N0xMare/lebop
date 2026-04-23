import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerSet(program: Command): void {
  program
    .command("set <field> <id> <value...>")
    .description("single-shot point edit (title | state | priority | assignee | labels)")
    .option("--json", "emit structured result")
    .addHelpText(
      "after",
      `
Examples:
  leebop set state TEAM-101 "In Progress"
  leebop set priority TEAM-101 urgent
  leebop set assignee TEAM-101 @me
  leebop set labels TEAM-101 +urgent -area:backend
  leebop set links TEAM-101 +blocks:TEAM-102,related:TEAM-103   (Phase 2)`,
    )
    .action(() => notImplemented("leebop set", "Phase 1"));
}
