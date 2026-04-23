import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerPull(program: Command): void {
  program
    .command("pull [ids...]")
    .description("fetch Linear entities into ~/.leebop/cache for local editing")
    .option("--project <name>", "fetch a project and its child issues")
    .option("--project-id <uuid>", "fetch by project UUID")
    .option("--refresh", "overwrite local cache even if it has unpushed edits")
    .option("--no-comments", "skip fetching comments")
    .option("--json", "emit structured summary")
    .action(() => notImplemented("leebop pull", "Phase 1"));
}
