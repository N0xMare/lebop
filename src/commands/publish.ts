import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import type {
  PublishLinearChangesResult,
  ReviewLinearChangesResult,
} from "../lib/linearPublish.ts";
import {
  buildPublishApplyInputFromCli,
  buildPublishReviewInputFromCli,
  executePublishApply,
  executePublishReview,
} from "../surface/publish.ts";

interface ReviewOpts {
  plan?: string;
  cache?: boolean;
  projectId?: string[];
  allModified?: boolean;
  team?: string;
  strict?: boolean;
  json?: boolean;
}

interface ApplyOpts {
  verify?: boolean;
  json?: boolean;
}

export function registerPublish(program: Command): void {
  const publish = program
    .command("publish")
    .description("review, publish, and verify agent-authored Linear changes");

  publish
    .command("review [ids...]")
    .description("validate, lint, diff, dry-run, and store a publish review")
    .option("--plan <dir>", "plan directory to review")
    .option("--cache", "review modified local cache rows instead of a plan directory")
    .option(
      "--project-id <uuid>",
      "review a specific modified cached project; repeatable",
      collect,
      [],
    )
    .option(
      "--all-modified",
      "review every modified cached row when --cache has no explicit targets",
    )
    .option("--team <key>", "override the resolved team")
    .option("--strict", "treat lint warnings as blockers")
    .option("--json", "emit structured result")
    .action(async (ids: string[], opts: ReviewOpts) => {
      const result = await executePublishReview(buildPublishReviewInputFromCli({ ids, opts }));
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ ...result }), null, 2)}\n`);
      } else {
        printReview(result);
      }
      if (!result.ready) process.exitCode = 1;
    });

  publish
    .command("apply <review-id>")
    .description("publish a stored review and verify the resulting remote state")
    .option("--no-verify", "skip post-publish plan diff verification")
    .option("--json", "emit structured result")
    .action(async (reviewId: string, opts: ApplyOpts) => {
      const result = await executePublishApply(buildPublishApplyInputFromCli({ reviewId, opts }));
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ ...result }), null, 2)}\n`);
      } else {
        printApply(result);
      }
      if (!isSuccessfulApplyStatus(result.status)) process.exitCode = 1;
    });
}

function isSuccessfulApplyStatus(status: PublishLinearChangesResult["status"]) {
  return status === "verified" || status === "published_unverified";
}

function printReview(result: ReviewLinearChangesResult): void {
  const state = result.ready ? chalk.green("ready") : chalk.red("blocked");
  process.stdout.write(`${state} ${chalk.bold(result.review_id)}\n`);
  if (result.source.kind === "plan") {
    process.stdout.write(`plan: ${result.source.dir}\n`);
  } else {
    process.stdout.write(`cache: ${result.source.repo_hash}\n`);
  }
  process.stdout.write(
    `planned: ${result.summary.planned_entities.projects} project(s), ${result.summary.planned_entities.issues} issue(s)\n`,
  );
  if (result.summary.blockers.length > 0) {
    process.stdout.write("\nblockers:\n");
    for (const blocker of result.summary.blockers) process.stdout.write(`  - ${blocker}\n`);
  }
  process.stdout.write(
    `\nwarnings: ${result.summary.warnings} · drift: ${result.summary.drift ? "yes" : "no"}\n`,
  );
  if (result.ready) {
    const next = result.next;
    if (!next) return;
    process.stdout.write(
      `next: lebop --workspace ${next.arguments.workspace} publish apply ${result.review_id}\n`,
    );
  }
}

function printApply(result: PublishLinearChangesResult): void {
  const color =
    result.status === "verified"
      ? chalk.green
      : result.status === "blocked"
        ? chalk.red
        : chalk.yellow;
  process.stdout.write(`${color(result.status)} ${chalk.bold(result.review_id)}\n`);
  if (result.summary.blockers.length > 0) {
    process.stdout.write("\nblockers:\n");
    for (const blocker of result.summary.blockers) process.stdout.write(`  - ${blocker}\n`);
  }
  if (result.verification) {
    const drift =
      "has_drift" in result.verification
        ? result.verification.has_drift ||
          result.verification.has_blockers ||
          result.verification.has_incomplete_scan
        : !result.verification.clean;
    process.stdout.write(`verification drift: ${drift ? "yes" : "no"}\n`);
  }
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
