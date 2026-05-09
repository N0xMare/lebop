import type { LinearClient } from "@linear/sdk";
import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { paginateConnection } from "../lib/paginate.ts";
import { linear } from "../lib/sdk.ts";

type IssueFilter = NonNullable<Parameters<LinearClient["issues"]>[0]>["filter"];

export function registerList(program: Command): void {
  program
    .command("list")
    .description("discover issues by filter (no cache side-effect)")
    .option("--team <key>")
    .option("--project <name>")
    .option("--project-id <uuid>")
    .option("--state <name>")
    .option("--state-type <type>", "backlog | unstarted | started | completed | canceled")
    .option("--assignee <who>", "me | email | name")
    .option("--label <name>", "repeatable", collect, [])
    .option("--priority <n>")
    .option("--updated-since <when>", "e.g. 7d | 24h | ISO timestamp")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured issue records")
    .action(async (opts: ListOpts) => {
      const config = await resolveConfig({ teamOverride: opts.team });
      const client = await linear();
      const filter: NonNullable<IssueFilter> = {};
      filter.team = { key: { eq: config.team } };

      if (opts.project) filter.project = { name: { eq: opts.project } };
      if (opts.projectId) filter.project = { id: { eq: opts.projectId } };
      if (opts.state) filter.state = { name: { eq: opts.state } };
      if (opts.stateType) filter.state = { ...filter.state, type: { eq: opts.stateType } };
      if (opts.priority !== undefined) {
        filter.priority = { eq: Number.parseInt(opts.priority, 10) };
      }
      if (opts.label && opts.label.length > 0) {
        filter.labels = { some: { name: { in: opts.label } } };
      }
      if (opts.assignee) {
        if (opts.assignee === "me" || opts.assignee === "@me") {
          const viewer = await client.viewer;
          filter.assignee = { id: { eq: viewer.id } };
        } else if (opts.assignee.includes("@")) {
          filter.assignee = { email: { eq: opts.assignee } };
        } else {
          filter.assignee = { name: { eq: opts.assignee } };
        }
      }
      if (opts.updatedSince) {
        filter.updatedAt = { gte: parseRelative(opts.updatedSince) };
      }

      const requested = Number.parseInt(opts.limit ?? "50", 10);
      // `--limit 0` ⇒ no user-specified cap; the paginator's safety cap (10k) still applies.
      const max = requested === 0 ? Number.POSITIVE_INFINITY : Math.max(1, requested);
      const issues = await paginateConnection(
        ({ first, after }) => client.issues({ filter, first, after }),
        { max, pageSize: 250 },
      );

      const records = await Promise.all(
        issues.map(async (i) => {
          const [state, assignee] = await Promise.all([i.state, i.assignee]);
          return {
            identifier: i.identifier,
            title: i.title,
            state: state?.name ?? null,
            state_type: state?.type ?? null,
            priority: i.priority,
            assignee: assignee ? { name: assignee.name, email: assignee.email } : null,
            updated_at: i.updatedAt.toISOString(),
            url: i.url,
          };
        }),
      );

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            { schema_version: 1, team: config.team, count: records.length, issues: records },
            null,
            2,
          )}\n`,
        );
        return;
      }

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
    });
}

interface ListOpts {
  team?: string;
  project?: string;
  projectId?: string;
  state?: string;
  stateType?: string;
  assignee?: string;
  label?: string[];
  priority?: string;
  updatedSince?: string;
  limit?: string;
  json?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseRelative(input: string): Date {
  const m = input.match(/^(\d+)([dhm])$/);
  if (m?.[1] && m[2]) {
    const n = Number.parseInt(m[1], 10);
    const unitMs = m[2] === "d" ? 86400_000 : m[2] === "h" ? 3600_000 : 60_000;
    return new Date(Date.now() - n * unitMs);
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`unrecognised time format: ${input} (use Nd|Nh|Nm or ISO 8601)`);
  }
  return d;
}
