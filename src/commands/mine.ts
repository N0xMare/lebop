import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
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

      const records = await listIssues({
        resolvedTeam: opts.allTeams ? undefined : config.team,
        team: opts.team,
        allTeams: opts.allTeams,
        assignee: "me",
        stateType: opts.stateType,
        stateTypeIn,
        label: opts.label,
        priority: opts.priority !== undefined ? Number.parseInt(opts.priority, 10) : undefined,
        cycle: opts.cycle,
        milestone: opts.milestone,
        includeArchived: opts.includeArchived,
        max,
      });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              team: opts.allTeams ? "*" : config.team,
              count: records.length,
              issues: records,
            },
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
