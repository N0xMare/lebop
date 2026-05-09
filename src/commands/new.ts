import chalk from "chalk";
import type { Command } from "commander";
import type { TeamMetadata } from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import {
  ResolveError,
  getTeamMetadata,
  resolveAssigneeId,
  resolveLabelIds,
  resolvePriority,
  resolveStateId,
  withFreshMetadataOnMiss,
} from "../lib/resolve.ts";
import { linear } from "../lib/sdk.ts";

interface NewOpts {
  team?: string;
  title?: string;
  project?: string;
  projectId?: string;
  state?: string;
  priority?: string;
  label?: string[];
  assignee?: string;
  description?: string;
  descriptionFile?: string;
  stdin?: boolean;
  json?: boolean;
}

export function registerNew(program: Command): void {
  program
    .command("new")
    .description("create a new Linear issue")
    .requiredOption("--title <text>", "issue title")
    .option("--team <key>", "team key; overrides the resolved team")
    .option("--project <name>", "assign to a project by name")
    .option("--project-id <uuid>", "assign to a project by UUID")
    .option("--state <name>", "initial workflow state; defaults to team default")
    .option("--priority <value>", "priority (none|urgent|high|normal|low) or 0..4")
    .option("--label <name>", "repeatable; label to attach", collectLabel, [])
    .option("--assignee <who>", "assignee (email|name|@me)")
    .option(
      "--description <text>",
      "description body; use --description-file or --stdin for longer content",
    )
    .option("--description-file <path>", "read description from a file")
    .option("--stdin", "read description from stdin")
    .option("--json", "emit structured result")
    .action(async (opts: NewOpts) => {
      const config = await resolveConfig({ teamOverride: opts.team });
      const description = await resolveDescription(opts);
      const priority = opts.priority !== undefined ? resolvePriority(opts.priority) : undefined;

      const { teamMetadata, labelIds, stateId, assigneeId, projectId } =
        await withFreshMetadataOnMiss(
          (o) => getTeamMetadata(config.repoHash, config.team, o),
          async (md: TeamMetadata) => ({
            teamMetadata: md,
            labelIds: opts.label?.length ? resolveLabelIds(md, opts.label) : undefined,
            stateId: opts.state ? resolveStateId(md, opts.state) : undefined,
            assigneeId: opts.assignee ? await resolveAssigneeId(md, opts.assignee) : undefined,
            projectId: opts.projectId ?? resolveProjectId(md, opts.project),
          }),
        );

      const input: Record<string, unknown> = {
        teamId: teamMetadata.team_id,
        title: opts.title,
      };
      if (description !== undefined) input.description = description;
      if (stateId !== undefined) input.stateId = stateId;
      if (priority !== undefined) input.priority = priority;
      if (labelIds !== undefined) input.labelIds = labelIds;
      if (assigneeId !== undefined) input.assigneeId = assigneeId;
      if (projectId !== undefined) input.projectId = projectId;

      // issueCreate is NOT wrapped with retry — duplicate creation could
      // result if the first attempt succeeded but the response was lost.
      const client = await linear();
      const response = (await client.client.rawRequest(CREATE_MUTATION, { input })) as {
        data: {
          issueCreate: {
            success: boolean;
            issue: {
              id: string;
              identifier: string;
              url: string;
              title: string;
              state: { name: string };
              project: { name: string } | null;
            };
          };
        };
      };

      const issue = response.data.issueCreate.issue;

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, issue }, null, 2)}\n`);
        return;
      }

      process.stdout.write(
        `${chalk.green("✓")} ${chalk.bold(issue.identifier)} created · [${chalk.cyan(issue.state.name)}]${
          issue.project ? ` · ${chalk.gray(issue.project.name)}` : ""
        }\n${chalk.gray(issue.url)}\n`,
      );
    });
}

function collectLabel(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function resolveProjectId(
  teamMetadata: { projects: { id: string; name: string }[] },
  projectName: string | undefined,
): string | undefined {
  if (!projectName) return undefined;
  const match = teamMetadata.projects.find(
    (p) => p.name.toLowerCase() === projectName.toLowerCase(),
  );
  if (!match) {
    const names = teamMetadata.projects.map((p) => `"${p.name}"`).join(", ");
    throw new ResolveError(`unknown project "${projectName}". available: ${names}`);
  }
  return match.id;
}

async function resolveDescription(opts: NewOpts): Promise<string | undefined> {
  const provided = [opts.description, opts.descriptionFile, opts.stdin].filter(Boolean).length;
  if (provided > 1) {
    throw new Error("choose at most one of --description / --description-file / --stdin");
  }
  if (opts.description !== undefined) return opts.description;
  if (opts.descriptionFile) return (await Bun.file(opts.descriptionFile).text()).trimEnd();
  if (opts.stdin) return (await Bun.stdin.text()).trimEnd();
  return undefined;
}

const CREATE_MUTATION = /* GraphQL */ `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        url
        title
        state { name }
        project { name }
      }
    }
  }
`;
