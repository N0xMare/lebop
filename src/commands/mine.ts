import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { ValidationError } from "../lib/errors.ts";
import { listIssues } from "../lib/listIssues.ts";
import { printHuman } from "./list.ts";

/**
 * `lebop mine` — shorthand for `list --assignee me` with a sensible default
 * state filter (active work only). Mirrors `linear issue mine`.
 *
 * Defaults to active states (anything that's not completed or canceled).
 * Pass `--all-states` to include those.
 */
export function registerMine(program: Command): void {
  program
    .command("mine")
    .description("list issues assigned to you (defaults to active states)")
    .option("--team <key>")
    .option("--all-teams", "search across every team your token can access")
    .option("--all-states", "include completed + canceled (default: only active)")
    .option("--include-archived", "include archived issues")
    .option("--state-type <type>", "narrow to a single state type (overrides --all-states)")
    .option("--label <name>", "repeatable", collect, [])
    .option("--priority <n>", "0..4")
    .option("--cycle <name-or-id>")
    .option("--milestone <name-or-id>")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured issue records")
    .action(async (opts: MineOpts) => {
      const config = await resolveConfig({ teamOverride: opts.team });
      const requested = Number.parseInt(opts.limit ?? "50", 10);
      const max = requested === 0 ? Number.POSITIVE_INFINITY : Math.max(1, requested);

      // Default state filter: active states only (everything but completed +
      // canceled). Pushed server-side via `state.type.in` so `--limit 50`
      // actually returns up to 50 active issues, not 50 raw issues then a
      // client-side filter. Explicit `--state-type` narrows further;
      // `--all-states` drops the filter entirely.
      const stateTypeIn =
        opts.stateType || opts.allStates
          ? undefined
          : ["triage", "backlog", "unstarted", "started"];

      // Round-9 / M-5: validate `--priority` at the boundary, parity with
      // `lebop list` (round-6 / H9, round-8 / R6-LOW-2). Pre-fix `mine
      // --priority 99` silently returned an empty result; now it fails
      // loud with `code:"validation_error"` like the sibling command.
      let priority: number | undefined;
      if (opts.priority !== undefined) {
        const n = Number(opts.priority);
        if (!Number.isInteger(n) || n < 0 || n > 4) {
          throw new ValidationError(
            `invalid --priority value "${opts.priority}"`,
            "priority must be an integer 0..4 (none|urgent|high|normal|low)",
          );
        }
        priority = n;
      }

      const records = await listIssues({
        resolvedTeam: opts.allTeams ? undefined : config.team,
        team: opts.team,
        allTeams: opts.allTeams,
        assignee: "me",
        stateType: opts.stateType,
        stateTypeIn,
        label: opts.label,
        priority,
        cycle: opts.cycle,
        milestone: opts.milestone,
        includeArchived: opts.includeArchived,
        max,
      });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              team: opts.allTeams ? "*" : config.team,
              count: records.length,
              issues: records,
            }),
            null,
            2,
          )}\n`,
        );
        return;
      }

      printHuman(records);
    });
}

interface MineOpts {
  team?: string;
  allTeams?: boolean;
  allStates?: boolean;
  includeArchived?: boolean;
  stateType?: string;
  label?: string[];
  priority?: string;
  cycle?: string;
  milestone?: string;
  limit?: string;
  json?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
