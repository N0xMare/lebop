import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerList(program: Command): void {
  program
    .command("list")
    .description("discover issues by filter (no cache side-effect)")
    .option("--project <name>")
    .option("--project-id <uuid>")
    .option("--state <name>")
    .option("--state-type <type>", "backlog | unstarted | started | completed | cancelled")
    .option("--assignee <who>", "me | email | name")
    .option("--label <name...>")
    .option("--priority <n>")
    .option("--updated-since <when>", "e.g. 7d or ISO timestamp")
    .option("--limit <n>", "default 50", "50")
    .option("--team <key>")
    .option("--json", "emit structured issue records")
    .action(() => notImplemented("leebop list", "Phase 1"));
}
