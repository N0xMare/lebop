import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { ValidationError } from "../lib/errors.ts";
import { pullNext } from "../lib/nextStubs.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import { type PullOperationResult, PullOverwriteConflictError } from "../lib/pullOperations.ts";
import {
  buildPullIssuesInputFromCli,
  buildPullProjectInputFromCli,
  executePullIssues,
  executePullProject,
} from "../surface/pull.ts";

export function registerPull(program: Command): void {
  program
    .command("pull [ids...]")
    .description("fetch Linear entities into ~/.lebop/cache for local editing")
    .option("--team <key>", "override the resolved team")
    .option("--project <name-or-id>", "fetch a project (name or UUID) and its child issues")
    .option("--project-id <uuid>", "fetch by project UUID")
    .option("--refresh", "overwrite local cache even if it has unpushed edits")
    .option("--yes", "confirm --refresh overwrite behavior")
    .option("--confirm", "alias for --yes")
    .option("--no-comments", "skip fetching comments")
    .option(
      "--to <dir>",
      "write files to <dir>/<id>/ instead of the cache. export-only: `status` and `push` operate on the default cache only",
    )
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(async (ids: string[], opts: PullOpts) => {
      if (ids.length === 0 && !opts.project && !opts.projectId) {
        throw new ValidationError(
          "nothing to pull — pass issue IDs or --project / --project-id",
          "examples: `lebop pull TEAM-34 TEAM-35` (issue ids) or `lebop pull --project 'My Project'`",
        );
      }
      if (opts.refresh === true && !isConfirmed(opts)) {
        throw new ValidationError(
          "refusing to pull with --refresh without --yes/--confirm",
          "push local edits first, remove --refresh, or pass --yes/--confirm after verifying local cache overwrite is intended",
        );
      }

      let result: PullOperationResult;
      try {
        result =
          opts.project || opts.projectId
            ? await executePullProject(buildPullProjectInputFromCli({ ids, opts }))
            : await executePullIssues(buildPullIssuesInputFromCli({ ids, opts }));
      } catch (err) {
        if (err instanceof PullOverwriteConflictError) {
          if (wantsMachineOutput(opts)) printConflictJson(err, opts);
          else printConflict(err);
          return;
        }
        throw err;
      }

      if (wantsMachineOutput(opts)) {
        writeMachineEnvelope(
          { ...result, next: pullNext() } as Record<string, unknown>,
          {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          },
        );
        if (result.errors.length > 0) process.exitCode = 1;
        return;
      }

      if (result.project) {
        process.stdout.write(
          `${chalk.green("✓")} pulled project ${chalk.bold(result.project.name)} (${result.project.issues} child issues) → ${chalk.cyan(result.project.path)}\n`,
        );
      }
      for (const r of result.issues) {
        const commentSuffix = r.comments > 0 ? chalk.gray(` (${r.comments} comments)`) : "";
        process.stdout.write(
          `${chalk.green("✓")} ${r.identifier}${commentSuffix} → ${chalk.cyan(r.path)}\n`,
        );
      }
      for (const e of result.errors) {
        process.stdout.write(`${chalk.red("✗")} ${e.identifier}: ${e.error}\n`);
      }
      if (result.mode === "export") {
        process.stdout.write(
          chalk.gray(
            `\nexport mode: \`lebop status\` and \`lebop push\` operate on the default cache only — edits here won't round-trip.\n`,
          ),
        );
      }
      if (result.errors.length > 0) process.exitCode = 1;
    });
}

interface PullOpts {
  team?: string;
  project?: string;
  projectId?: string;
  refresh?: boolean;
  yes?: boolean;
  confirm?: boolean;
  comments?: boolean; // commander inverts --no-comments into comments=false
  to?: string;
  json?: boolean;
  format?: string;
  pretty?: boolean;
}

function printConflict(err: PullOverwriteConflictError): void {
  process.stderr.write(
    `${chalk.yellow("refusing to overwrite local edits on:")} ${err.conflicts.join(", ")}\n`,
  );
  process.stderr.write(
    `  push them with ${chalk.cyan("lebop push")} or re-run with ${chalk.cyan("--refresh --yes")}\n`,
  );
  process.exitCode = 1;
}

function printConflictJson(
  err: PullOverwriteConflictError,
  opts: Pick<PullOpts, "format" | "pretty">,
): void {
  writeMachineEnvelope(
    {
      ok: false,
      error: {
        code: "cache_conflict",
        message: err.message,
        conflicts: err.conflicts,
        hint: "push local edits with `lebop push` or re-run with --refresh --yes",
      },
    },
    {
      json: true,
      format: opts.format,
      pretty: opts.pretty,
    },
  );
  process.exitCode = 1;
}

function isConfirmed(opts: Pick<PullOpts, "yes" | "confirm">): boolean {
  return opts.yes === true || opts.confirm === true;
}
