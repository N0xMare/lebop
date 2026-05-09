import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { type ListedIssue, listIssues } from "../lib/listIssues.ts";

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
        priority: opts.priority !== undefined ? Number.parseInt(opts.priority, 10) : undefined,
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
