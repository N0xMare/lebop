import chalk from "chalk";
import type { Command } from "commander";
import { buildIssueMetadata } from "../lib/build.ts";
import { readIssue, writeIssue } from "../lib/cache.ts";
import type { TeamMetadata } from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import type { FetchedIssue } from "../lib/pullQuery.ts";
import { ISSUE_UPDATE_MUTATION, type IssueUpdateInput } from "../lib/pushMutations.ts";
import {
  getTeamMetadata,
  resolveAssigneeId,
  resolveLabelId,
  resolveLabelIds,
  resolvePriority,
  resolveStateId,
} from "../lib/resolve.ts";
import { linear } from "../lib/sdk.ts";

const SUPPORTED_FIELDS = ["title", "state", "priority", "assignee", "labels"] as const;
type SupportedField = (typeof SUPPORTED_FIELDS)[number];
const UNSUPPORTED_FIELDS = new Set(["description", "content"]);

export function registerSet(program: Command): void {
  program
    .command("set <field> <id> <value...>")
    .description("single-shot point edit (title | state | priority | assignee | labels)")
    .option("--team <key>", "override the resolved team")
    .option("--json", "emit structured result")
    .addHelpText(
      "after",
      `
Examples:
  leebop set state TEAM-101 "In Progress"
  leebop set priority TEAM-101 urgent
  leebop set assignee TEAM-101 @me
  leebop set assignee TEAM-101 null           (unassign)
  leebop set labels TEAM-101 +urgent -area:backend
  leebop set labels TEAM-101 =area:backend,bug  (exact replacement)
  leebop set title TEAM-101 "new title here"
`,
    )
    .action(async (field: string, id: string, valueArgs: string[], opts: SetOpts) => {
      if (UNSUPPORTED_FIELDS.has(field)) {
        throw new Error(
          `\`set ${field}\` is deliberately unsupported (${field} is a large multi-line field). use \`leebop pull ${id}\` → edit → \`leebop push\` instead.`,
        );
      }
      if (!SUPPORTED_FIELDS.includes(field as SupportedField)) {
        throw new Error(`unknown field "${field}". supported: ${SUPPORTED_FIELDS.join(", ")}`);
      }

      const value = valueArgs.join(" ");
      if (!value) throw new Error(`missing value for \`set ${field} ${id}\``);

      const config = await resolveConfig({ teamOverride: opts.team });
      const client = await linear();

      // Fetch full issue first so we have current state (needed for labels delta).
      const issueSummary = await client.issue(id);
      if (!issueSummary) throw new Error(`issue not found: ${id}`);

      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      const input = await buildInput(
        field as SupportedField,
        value,
        valueArgs,
        issueSummary,
        teamMetadata,
      );

      const response = (await client.client.rawRequest(ISSUE_UPDATE_MUTATION, {
        id: issueSummary.id,
        input,
      })) as { data: { issueUpdate: { success: boolean; issue: FetchedIssue } } };

      const updated = response.data.issueUpdate.issue;

      // Refresh cache if this issue was cached.
      const cached = await readIssue(config.repoHash, id);
      if (cached) {
        const rebuilt = buildIssueMetadata(updated);
        await writeIssue(config.repoHash, rebuilt.metadata, updated.description ?? "");
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              identifier: id,
              field,
              input,
              updated_at: updated.updatedAt,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      process.stdout.write(
        `${chalk.green("✓")} ${chalk.bold(id)} ${field} updated${cached ? chalk.gray(" (cache refreshed)") : ""}\n`,
      );
    });
}

interface SetOpts {
  team?: string;
  json?: boolean;
}

async function buildInput(
  field: SupportedField,
  value: string,
  valueArgs: string[],
  issue: Awaited<ReturnType<Awaited<ReturnType<typeof linear>>["issue"]>>,
  teamMetadata: TeamMetadata,
): Promise<IssueUpdateInput> {
  switch (field) {
    case "title":
      return { title: value };
    case "state":
      return { stateId: resolveStateId(teamMetadata, value) };
    case "priority":
      return { priority: resolvePriority(value) };
    case "assignee":
      return { assigneeId: await resolveAssigneeId(teamMetadata, value) };
    case "labels":
      return { labelIds: await resolveLabelsInput(valueArgs, issue, teamMetadata) };
  }
}

async function resolveLabelsInput(
  tokens: string[],
  issue: Awaited<ReturnType<Awaited<ReturnType<typeof linear>>["issue"]>>,
  teamMetadata: TeamMetadata,
): Promise<string[]> {
  // Exact-replace form: `=foo,bar` (single token with `=` prefix)
  if (tokens.length === 1 && tokens[0]?.startsWith("=")) {
    const names = tokens[0]
      .slice(1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return resolveLabelIds(teamMetadata, names);
  }

  // Delta form: `+foo -bar ...`
  const current = await issue.labels();
  const currentIds = new Set(current.nodes.map((l) => l.id));

  for (const token of tokens) {
    if (token.startsWith("+")) {
      currentIds.add(resolveLabelId(teamMetadata, token.slice(1)));
    } else if (token.startsWith("-")) {
      const id = resolveLabelId(teamMetadata, token.slice(1));
      currentIds.delete(id);
    } else {
      throw new Error(
        `label token "${token}" must start with + or - (delta) or use =a,b,c (exact replacement)`,
      );
    }
  }

  return Array.from(currentIds);
}
