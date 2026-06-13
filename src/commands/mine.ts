import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { getTeam } from "../lib/teams.ts";
import {
  buildIssueMineInputFromCli,
  executeIssueList,
  issueListPayload,
} from "../surface/issues.ts";
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
    .option("--cursor <token>", "continue from a previous JSON result's next_cursor")
    .option("--json", "emit structured issue records")
    .action(async (opts: MineOpts) => {
      const result = await executeIssueList(buildIssueMineInputFromCli({ opts }), {
        resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
        getTeam: async (team) => getTeam(team),
      });

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(issueListPayload(result)), null, 2)}\n`);
        return;
      }

      printHuman(result.issues);
      if (result.truncated) {
        process.stdout.write(
          `\nmore results available; use --cursor ${result.next_cursor} with the same filters\n`,
        );
      }
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
  cursor?: string;
  json?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
