import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerDiff(program: Command): void {
  program
    .command("diff <id>")
    .description("show a unified diff of local cache vs live remote")
    .option("--json", "emit structured diff")
    .action(() => notImplemented("leebop diff", "Phase 4"));
}
