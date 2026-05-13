import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import { type ListedIssue, listIssues } from "../lib/listIssues.ts";
import { getTeam } from "../lib/teams.ts";

export function registerList(program: Command): void {
  program
    .command("list")
    .description("discover issues by filter (no cache side-effect)")
    .option("--team <key>")
    .option("--all-teams", "search across every team your token can access")
    .option("--project <name>")
    .option("--project-id <uuid>")
    .option("--state <name>")
    .option("--state-type <type>", "triage | backlog | unstarted | started | completed | canceled")
    .option("--assignee <who>", "me | email | name | * (any assignee)")
    .option("--unassigned", "show only unassigned issues (mutually exclusive with --assignee)")
    .option("--label <name>", "repeatable", collect, [])
    .option("--priority <n>", "0..4")
    .option("--cycle <name-or-id>", "cycle by name or UUID")
    .option("--milestone <name-or-id>", "project milestone by name or UUID")
    .option("--updated-since <when>", "e.g. 7d | 24h | ISO timestamp")
    .option("--created-after <when>", "e.g. 7d | 24h | ISO timestamp")
    .option("--search <text>", "full-text search across title + description")
    .option("--include-archived", "include archived issues")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured issue records")
    .action(async (opts: ListOpts) => {
      const config = await resolveConfig({ teamOverride: opts.team });
      const requested = Number.parseInt(opts.limit ?? "50", 10);
      const max = requested === 0 ? Number.POSITIVE_INFINITY : Math.max(1, requested);

      // Round-8 / R8-LOW-6: pre-validate team existence so a bad `--team`
      // surfaces as a clean NotFoundError instead of silently returning
      // `count: 0`. Mirrors round-7 / A11 (which fixed the MCP side via
      // `list_issues` pre-check) — closes the CLI parity gap.
      if (!opts.allTeams && config.team) {
        const t = await getTeam(config.team);
        if (!t) {
          throw new NotFoundError(
            `team not found: ${config.team}`,
            "run `lebop teams` to see available team keys",
          );
        }
      }

      const records = await listIssues({
        resolvedTeam: opts.allTeams ? undefined : config.team,
        team: opts.team,
        allTeams: opts.allTeams,
        project: opts.project,
        projectId: opts.projectId,
        state: opts.state,
        stateType: opts.stateType,
        assignee: opts.assignee,
        unassigned: opts.unassigned,
        label: opts.label,
        // Round-6 / H9: validate priority at the boundary. Pre-fix the
        // CLI silently accepted any value (priority=99, priority=bogus →
        // "no matching issues" exit 0). The lib's `listIssues` path doesn't
        // gate priority since it builds a filter; bad values silently
        // returned nothing. Fail loud instead.
        priority:
          opts.priority !== undefined
            ? (() => {
                // Round-8 / R6-LOW-2: strict integer parse. `Number.parseInt`
                // accepted `"3abc"` (→3), `"3.7"` (→3), trailing whitespace
                // — making the validation hint misleading. Use `Number()` +
                // `Number.isInteger()` so the bound check operates on a
                // truly-integer value.
                const n = Number(opts.priority);
                if (!Number.isInteger(n) || n < 0 || n > 4) {
                  throw new ValidationError(
                    `invalid --priority value "${opts.priority}"`,
                    "priority must be an integer 0..4 (none|urgent|high|normal|low)",
                  );
                }
                return n;
              })()
            : undefined,
        cycle: opts.cycle,
        milestone: opts.milestone,
        updatedSince: opts.updatedSince,
        createdAfter: opts.createdAfter,
        search: opts.search,
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

interface ListOpts {
  team?: string;
  allTeams?: boolean;
  project?: string;
  projectId?: string;
  state?: string;
  stateType?: string;
  assignee?: string;
  unassigned?: boolean;
  label?: string[];
  priority?: string;
  cycle?: string;
  milestone?: string;
  updatedSince?: string;
  createdAfter?: string;
  search?: string;
  includeArchived?: boolean;
  limit?: string;
  json?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function printHuman(records: ListedIssue[]): void {
  if (records.length === 0) {
    process.stdout.write("no matching issues\n");
    return;
  }
  const identWidth = Math.max(...records.map((r) => r.identifier.length));
  const stateWidth = Math.max(...records.map((r) => (r.state ?? "").length));
  for (const r of records) {
    const who = r.assignee ? `  (${r.assignee.name})` : "";
    process.stdout.write(
      `${r.identifier.padEnd(identWidth)}  [${(r.state ?? "-").padEnd(stateWidth)}]  ${r.title}${who}\n`,
    );
  }
}
