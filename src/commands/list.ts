import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import type { ListedIssue } from "../lib/listIssues.ts";
import { getTeam } from "../lib/teams.ts";
import {
  buildIssueListInputFromCli,
  executeIssueList,
  issueListPayload,
} from "../surface/issues.ts";

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
    .option("--cursor <token>", "continue from a previous JSON result's next_cursor")
    .option("--json", "emit structured issue records")
    .action(async (opts: ListOpts) => {
      const result = await executeIssueList(buildIssueListInputFromCli({ opts }), {
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
  cursor?: string;
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
