import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerLint(program: Command): void {
  program
    .command("lint [paths...]")
    .description("lint local markdown files for Linear renderer quirks")
    .option("--fix", "auto-apply safe rewrites")
    .option("--strict", "exit non-zero on any warning")
    .action(() => notImplemented("leebop lint", "Phase 3"));
}
