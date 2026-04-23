import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerComment(program: Command): void {
  program
    .command("comment <id>")
    .description("add a comment to an issue")
    .option("--body <text>", "comment body (inline)")
    .option("--body-file <path>", "comment body from a file")
    .option("--stdin", "read body from stdin")
    .option("--json", "emit structured result")
    .action(() => notImplemented("leebop comment", "Phase 1"));
}
