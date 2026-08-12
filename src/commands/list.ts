import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { wantsMachineOutput } from "../lib/encode.ts";
import { projectListedIssuesResult, type SlimListedIssue } from "../lib/listIssues.ts";
import { listNext } from "../lib/nextStubs.ts";
import { addMachineOutputOptions, writeMachineEnvelope } from "../lib/output.ts";
import { getTeam } from "../lib/teams.ts";
import {
  buildIssueListInputFromCli,
  executeIssueList,
  issueListPayload,
} from "../surface/issues.ts";

export function registerList(program: Command): void {
  const cmd = program
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
    .option("--due-before <when>", "due date on or before (YYYY-MM-DD or relative)")
    .option("--due-after <when>", "due date on or after")
    .option("--updated-since <when>", "e.g. 7d | 24h | ISO timestamp")
    .option("--created-after <when>", "e.g. 7d | 24h | ISO timestamp")
    .option("--search <text>", "full-text search across title + description")
    .option("--include-archived", "include archived issues")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--cursor <token>", "continue from a previous JSON result's next_cursor")
    .option("--fields <list>", "default slim fields, or full, or comma list");
  addMachineOutputOptions(cmd);
  cmd.action(async (opts: ListOpts) => {
    const result = await executeIssueList(buildIssueListInputFromCli({ opts }), {
      resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
      getTeam: async (team) => getTeam(team),
    });

    const { issues: slimIssues, fields } = projectListedIssuesResult(result, opts.fields);
    const payload = {
      ...issueListPayload({ ...result, issues: slimIssues as typeof result.issues }),
      fields,
      next: listNext(Boolean(result.truncated), result.next_cursor, {
        show: "show <id>",
        fieldsCmd: "list --fields full",
      }),
    };

    if (wantsMachineOutput(opts)) {
      writeMachineEnvelope(payload, {
        json: true,
        format: opts.format,
        pretty: opts.pretty,
      });
      return;
    }

    printHuman(slimIssues);
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
  dueBefore?: string;
  dueAfter?: string;
  updatedSince?: string;
  createdAfter?: string;
  search?: string;
  includeArchived?: boolean;
  limit?: string;
  cursor?: string;
  fields?: string;
  json?: boolean;
  format?: string;
  pretty?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function printHuman(records: SlimListedIssue[]): void {
  if (records.length === 0) {
    process.stdout.write("no matching issues\n");
    return;
  }
  const identWidth = Math.max(...records.map((r) => r.identifier.length));
  const stateWidth = Math.max(...records.map((r) => (r.state ?? "").length));
  for (const r of records) {
    const who = r.assignee
      ? `  (${typeof r.assignee === "string" ? r.assignee : r.assignee.name})`
      : "";
    process.stdout.write(
      `${r.identifier.padEnd(identWidth)}  [${(r.state ?? "-").padEnd(stateWidth)}]  ${r.title}${who}\n`,
    );
  }
}
