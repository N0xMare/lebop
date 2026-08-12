import chalk from "chalk";
import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { wantsMachineOutput } from "../lib/encode.ts";
import { ValidationError } from "../lib/errors.ts";
import { buildIssueCreateInputFromCli, executeIssueCreate } from "../surface/issues.ts";

interface NewOpts {
  team?: string;
  title?: string;
  project?: string;
  projectId?: string;
  state?: string;
  priority?: string;
  estimate?: string;
  label?: string[];
  assignee?: string;
  parent?: string;
  milestone?: string;
  cycle?: string;
  dueDate?: string;
  description?: string;
  descriptionFile?: string;
  stdin?: boolean;
  json?: boolean;
  format?: string;
  pretty?: boolean;
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
    .option("--estimate <points>", "estimate points")
    .option("--label <name>", "repeatable; label to attach", collectLabel, [])
    .option("--assignee <who>", "assignee (email|name|@me)")
    .option("--parent <id>", "parent issue identifier")
    .option("--milestone <name-or-id>", "project milestone")
    .option("--cycle <name-or-id>", "cycle")
    .option("--due-date <date>", "due date YYYY-MM-DD")
    .option(
      "--description <text>",
      "description body; use --description-file or --stdin for longer content",
    )
    .option("--description-file <path>", "read description from a file")
    .option("--stdin", "read description from stdin")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(async (opts: NewOpts) => {
      const description = await resolveDescription(opts);

      const { issue } = await executeIssueCreate(
        buildIssueCreateInputFromCli({ opts: { ...opts, description } }),
        { resolveConfig },
      );

      if (wantsMachineOutput(opts)) {
        const { writeMachineEnvelope } = await import("../lib/output.ts");
        writeMachineEnvelope(
          { issue, next: ["show <id>", "set …", "comment add <id>", "pull <id>"] },
          { json: true, format: opts.format, pretty: opts.pretty },
        );
        return;
      }

      process.stdout.write(
        `${chalk.green("✓")} ${chalk.bold(issue.identifier)} created · [${chalk.cyan(issue.state.name)}]${
          issue.project ? ` · ${chalk.gray(issue.project.name)}` : ""
        }\n${chalk.gray(issue.url)}\n`,
      );
    });
}

async function resolveDescription(opts: NewOpts): Promise<string | undefined> {
  const provided = [opts.description, opts.descriptionFile, opts.stdin].filter(Boolean).length;
  if (provided > 1) {
    throw new ValidationError(
      "choose at most one of --description / --description-file / --stdin",
      "provide only one description source",
    );
  }
  if (opts.description !== undefined) return opts.description;
  if (opts.descriptionFile) return (await Bun.file(opts.descriptionFile).text()).trimEnd();
  if (opts.stdin) return (await Bun.stdin.text()).trimEnd();
  return undefined;
}

function collectLabel(value: string, previous: string[]): string[] {
  return [...previous, value];
}
