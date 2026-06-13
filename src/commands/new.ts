import chalk from "chalk";
import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
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
    .option("--estimate <points>", "estimate points")
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
      const description = await resolveDescription(opts);

      const { issue } = await executeIssueCreate(
        buildIssueCreateInputFromCli({ opts: { ...opts, description } }),
        { resolveConfig },
      );

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ issue }), null, 2)}\n`);
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
