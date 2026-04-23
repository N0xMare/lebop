import type { Command } from "commander";
import { notImplemented } from "../lib/notImplemented.ts";

export function registerPush(program: Command): void {
  program
    .command("push [ids...]")
    .description("push locally-modified cache entries back to Linear")
    .option("--dry-run", "print diff and mutations; no API calls")
    .option("--force", "skip CAS staleness check (dangerous)")
    .option("--json", "emit structured per-entity result records")
    .action(() => notImplemented("leebop push", "Phase 1"));
}
