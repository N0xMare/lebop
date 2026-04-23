import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerProjects(program: Command): void {
  program
    .command("projects")
    .description("list projects in the team")
    .option("--team <key>")
    .option("--state <state>")
    .option("--json", "emit structured project records")
    .action(() => notImplemented("leebop projects", "Phase 1"));
}
