import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("git-like status for the current repo's leebop cache")
    .option("--json", "emit structured status")
    .action(() => notImplemented("leebop status", "Phase 1"));
}
