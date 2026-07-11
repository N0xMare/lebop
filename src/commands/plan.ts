import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import type { ApplyResult } from "../lib/planApply.ts";
import type { PlanDiffResult } from "../lib/planDiff.ts";
import type { PullResult } from "../lib/planPull.ts";
import type { ParsedPlan, ValidationResult } from "../lib/planTypes.ts";
import {
  buildPlanApplyInputFromCli,
  buildPlanDiffInputFromCli,
  buildPlanLintInputFromCli,
  buildPlanPullInputFromCli,
  buildPlanValidateInputFromCli,
  executePlanApply,
  executePlanDiff,
  executePlanLint,
  executePlanPull,
  executePlanValidate,
  hasPlanDiffFailure,
  planApplyCliPayload,
  planApplyHasErrors,
  planDiffCliPayload,
  planLintCliPayload,
  planPullCliPayload,
  planPullHasErrors,
  planValidateCliPayload,
} from "../surface/plan.ts";

interface CommonOpts {
  team?: string;
  json?: boolean;
}

interface ApplyCmdOpts extends CommonOpts {
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
  confirm?: boolean;
  strict?: boolean;
}

interface PullCmdOpts extends CommonOpts {
  force?: boolean;
  yes?: boolean;
  confirm?: boolean;
  includeNew?: boolean;
}

interface PlanLintOpts extends CommonOpts {
  fix?: boolean;
  strict?: boolean;
}

export function registerPlan(program: Command): void {
  const plan = program
    .command("plan")
    .description("realize a directory of markdown files as a Linear project + issues + links");

  plan
    .command("validate <dir>")
    .description("parse and validate a plan directory without writing to Linear")
    .option("--team <key>", "override the resolved team")
    .option("--json", "emit structured result")
    .action(async (dir: string, opts: CommonOpts) => {
      const result = await executePlanValidate(buildPlanValidateInputFromCli({ dir, opts }));

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope(planValidateCliPayload(result)), null, 2)}\n`,
        );
      } else {
        printValidate(result.parsed, result.validation);
      }
      if (result.errors.length > 0) process.exitCode = 1;
    });

  plan
    .command("apply <dir>")
    .description("create/update the project + issues + links described by the plan")
    .option("--team <key>", "override the resolved team")
    .option("--dry-run", "print the plan without writing to Linear")
    .option(
      "--force",
      "apply existing Linear updates even when plan updatedAt snapshots are missing/stale",
    )
    .option("--yes", "confirm --force when applying mutations")
    .option("--confirm", "alias for --yes")
    .option("--strict", "block any issue whose body has lint warnings")
    .option("--json", "emit structured result")
    .action(async (dir: string, opts: ApplyCmdOpts) => {
      const outcome = await executePlanApply(buildPlanApplyInputFromCli({ dir, opts }));

      if (outcome.kind === "validation_failed") {
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope(planApplyCliPayload(outcome)), null, 2)}\n`,
          );
        } else {
          printValidate(outcome.parsed, outcome.validation);
        }
        process.exitCode = 1;
        return;
      }

      if (outcome.warnings.length > 0 && !opts.json) {
        printWarnings(outcome.warnings);
      }

      if (outcome.kind === "preflight_failed") {
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope(planApplyCliPayload(outcome)), null, 2)}\n`,
          );
        } else {
          const label = outcome.dryRun ? "refusing dry-run preview:" : "refusing to apply:";
          process.stderr.write(`${chalk.yellow(label)} plan preflight failed\n`);
          for (const blocker of outcome.preflight.blockers) {
            process.stderr.write(`  - ${blocker}\n`);
          }
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope(planApplyCliPayload(outcome)), null, 2)}\n`,
        );
      } else {
        printApply(outcome.result, outcome.dryRun);
      }

      if (planApplyHasErrors(outcome)) process.exitCode = 1;
    });

  plan
    .command("diff <dir>")
    .description("show drift between plan files and live Linear")
    .option("--team <key>", "override the resolved team")
    .option("--json", "emit structured result")
    .action(async (dir: string, opts: CommonOpts) => {
      const outcome = await executePlanDiff(buildPlanDiffInputFromCli({ dir, opts }));

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(planDiffCliPayload(outcome)), null, 2)}\n`);
      } else {
        printDiff(outcome.result);
      }
      if (hasPlanDiffFailure(outcome.result)) process.exitCode = 1;
    });

  plan
    .command("lint <dir>")
    .description("lint every issue body in a plan directory against repo-scoped rules")
    .option("--team <key>", "override the resolved team")
    .option("--fix", "apply safe autofixes in-place (writes back to the .md files)")
    .option("--strict", "exit non-zero when any warning remains")
    .option("--json", "emit structured result")
    .action(async (dir: string, opts: PlanLintOpts) => {
      const result = await executePlanLint(buildPlanLintInputFromCli({ dir, opts }));

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(planLintCliPayload(result)), null, 2)}\n`);
      } else {
        let total = 0;
        let fixed = 0;
        for (const f of result.files) {
          if (f.warnings.length === 0) continue;
          process.stdout.write(`\n${chalk.bold(f.path)}\n`);
          for (const w of f.warnings) {
            const sev =
              w.severity === "warn"
                ? chalk.yellow("warn")
                : w.severity === "error"
                  ? chalk.red("error")
                  : chalk.gray("info");
            const hint = w.fix
              ? opts.fix
                ? chalk.green(" [fixed]")
                : chalk.gray(" [--fix available]")
              : "";
            process.stdout.write(
              `  ${chalk.dim(`L${w.line}:`)} ${sev} ${chalk.cyan(w.rule)} ${w.message}${hint}\n`,
            );
          }
          total += f.warnings.length;
          fixed += f.fixed;
        }
        process.stdout.write(
          `\n${chalk.gray(
            `${result.files.length} file(s) checked · ${total} warning(s)${opts.fix ? ` · ${fixed} fixed` : ""}\n`,
          )}`,
        );
      }

      if (result.strict && result.remaining_warnings > 0) process.exitCode = 1;
    });

  plan
    .command("pull <dir>")
    .description("bring remote Linear state back into plan files (overwrites local)")
    .option("--team <key>", "override the resolved team")
    .option("--force", "pull even if local has drift (overwrites local edits)")
    .option("--yes", "confirm --force overwrite behavior")
    .option("--confirm", "alias for --yes")
    .option("--include-new", "also import issues that exist on remote but not in the plan")
    .option("--json", "emit structured result")
    .action(async (dir: string, opts: PullCmdOpts) => {
      const outcome = await executePlanPull(buildPlanPullInputFromCli({ dir, opts }));

      if (outcome.kind === "refused") {
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              envelope({
                refused: outcome.refused,
                hint: outcome.cliHint,
                diff: outcome.diff,
              }),
              null,
              2,
            )}\n`,
          );
        } else if (outcome.diff.has_incomplete_scan) {
          process.stderr.write(
            `${chalk.yellow("refusing to pull:")} remote-only issue scan failed. Run \`lebop plan diff ${dir}\` to inspect, then retry once Linear is reachable or \`lebop plan pull ${dir} --force --yes\` after verifying local file overwrite is intended.\n`,
          );
        } else {
          process.stderr.write(
            `${chalk.yellow("refusing to pull:")} local plan has drift. Run \`lebop plan diff ${dir}\` to inspect, then \`lebop plan pull ${dir} --force --yes\` after verifying local file overwrite is intended.\n`,
          );
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(planPullCliPayload(outcome)), null, 2)}\n`);
      } else {
        printPull(outcome.result);
      }

      if (planPullHasErrors(outcome.result)) process.exitCode = 1;
    });
}

function printValidate(parsed: ParsedPlan, result: ValidationResult): void {
  process.stdout.write(
    `${chalk.bold(parsed.dir)}\n  project: ${chalk.cyan(parsed.project.frontmatter.name)}\n  issues: ${chalk.cyan(String(parsed.issues.length))}\n`,
  );
  if (result.errors.length > 0) {
    process.stdout.write(`\n${chalk.red(`${result.errors.length} error(s):`)}\n`);
    for (const e of result.errors) {
      const loc = e.path ? `${chalk.gray(e.path)}: ` : "";
      process.stdout.write(`  ${chalk.red("✗")} ${loc}${e.message}\n`);
    }
  }
  if (result.warnings.length > 0) printWarnings(result.warnings);
  if (result.errors.length === 0 && result.warnings.length === 0) {
    process.stdout.write(chalk.green("\nno errors or warnings\n"));
  }
}

function printWarnings(warnings: ValidationResult["warnings"]): void {
  process.stdout.write(`\n${chalk.yellow(`${warnings.length} warning(s):`)}\n`);
  for (const w of warnings) {
    const loc = w.path ? `${chalk.gray(w.path)}: ` : "";
    process.stdout.write(`  ${chalk.yellow("!")} ${loc}${chalk.cyan(w.rule)} ${w.message}\n`);
  }
}

function printApply(result: ApplyResult, dryRun: boolean): void {
  const tag = dryRun ? chalk.gray("[dry-run] ") : "";
  const projIcon = statusIcon(result.project.status);
  process.stdout.write(
    `${tag}${projIcon} project/${chalk.bold(result.project.name)}  ${chalk.gray(result.project.status)}${result.project.linearId ? chalk.gray(` (${result.project.linearId})`) : ""}${result.project.error ? `  ${chalk.red(result.project.error)}` : ""}\n`,
  );
  for (const i of result.issues) {
    const icon = statusIcon(i.status);
    const fields = i.fields?.length ? chalk.gray(`  [${i.fields.join(", ")}]`) : "";
    const idLabel = i.linearId ? chalk.bold(i.linearId) : chalk.bold(i.slug);
    process.stdout.write(
      `${tag}${icon} ${idLabel}  ${chalk.gray(i.status)}${fields}${i.error ? `  ${chalk.red(i.error)}` : ""}\n`,
    );
  }
  for (const r of result.relations) {
    const icon = statusIcon(r.status);
    process.stdout.write(
      `${tag}${icon} ${chalk.bold(r.fromIdentifier)} ${chalk.cyan(r.kind)} ${chalk.bold(r.toIdentifier)}  ${chalk.gray(r.status)}${r.error ? `  ${chalk.red(r.error)}` : ""}\n`,
    );
  }
  const createdIssues = result.issues.filter((i) => i.status === "created").length;
  const updatedIssues = result.issues.filter((i) => i.status === "updated").length;
  const unchangedIssues = result.issues.filter((i) => i.status === "unchanged").length;
  const createdRels = result.relations.filter((r) => r.status === "created").length;
  process.stdout.write(
    `\n${chalk.gray(
      `${createdIssues} issue(s) created · ${updatedIssues} updated · ${unchangedIssues} unchanged · ${createdRels} relation(s) created\n`,
    )}`,
  );
}

function printDiff(result: PlanDiffResult): void {
  if (!hasPlanDiffFailure(result)) {
    process.stdout.write(`${chalk.green("✓")} plan matches Linear — no drift\n`);
  }

  if (result.has_drift || result.has_blockers) {
    // Project
    const p = result.project;
    process.stdout.write(
      `${diffIcon(p.status)} project/${chalk.bold(p.name)}  ${chalk.gray(p.status)}${p.error ? `  ${chalk.red(p.error)}` : ""}\n`,
    );
    for (const f of p.field_changes) {
      process.stdout.write(
        `  ${chalk.cyan(f.field)}: ${chalk.red(JSON.stringify(f.remote))} ${chalk.gray("(remote)")} → ${chalk.green(JSON.stringify(f.local))} ${chalk.gray("(local)")}\n`,
      );
    }
    if (p.content_patch) printPatch(p.content_patch);

    // Issues
    for (const i of result.issues) {
      const label = i.linear_id ? chalk.bold(i.linear_id) : chalk.bold(i.slug);
      process.stdout.write(
        `${diffIcon(i.status)} ${label}  ${chalk.gray(i.status)}${i.error ? `  ${chalk.red(i.error)}` : ""}\n`,
      );
      for (const f of i.field_changes) {
        process.stdout.write(
          `  ${chalk.cyan(f.field)}: ${chalk.red(JSON.stringify(f.remote))} ${chalk.gray("(remote)")} → ${chalk.green(JSON.stringify(f.local))} ${chalk.gray("(local)")}\n`,
        );
      }
      for (const r of i.relations_missing_remote) {
        process.stdout.write(
          `  ${chalk.yellow("+")} ${chalk.cyan(r.kind)}:${r.target} ${chalk.gray("(in plan, not on remote)")}\n`,
        );
      }
      for (const r of i.relations_extra_remote) {
        process.stdout.write(
          `  ${chalk.yellow("-")} ${chalk.cyan(r.kind)}:${r.target} ${chalk.gray("(on remote, not in plan)")}\n`,
        );
      }
      if (i.body_patch) printPatch(i.body_patch);
    }
  }

  // Extra remote (not-in-plan) issues
  if (result.extra_remote_issues.length > 0) {
    process.stdout.write(
      `\n${chalk.yellow(`${result.extra_remote_issues.length} issue(s) on remote but not in plan:`)}\n`,
    );
    for (const e of result.extra_remote_issues) {
      process.stdout.write(
        `  ${chalk.yellow("?")} ${chalk.bold(e.identifier)} ${chalk.gray(e.title)}\n`,
      );
    }
    process.stdout.write(
      chalk.gray("  use `lebop plan pull <dir> --include-new` to import them\n"),
    );
  }
  if (result.extra_remote_issues_error) {
    process.stdout.write(
      `\n${chalk.red("remote-only issue scan failed:")} ${result.extra_remote_issues_error}\n`,
    );
  }
}

function printPull(result: PullResult): void {
  const p = result.project;
  process.stdout.write(
    `${pullIcon(p.status)} project/${chalk.bold(p.name)}  ${chalk.gray(p.status)}${p.error ? `  ${chalk.red(p.error)}` : ""}\n`,
  );
  for (const i of result.issues) {
    const label = i.linear_id ? chalk.bold(i.linear_id) : chalk.bold(i.slug);
    process.stdout.write(
      `${pullIcon(i.status)} ${label}  ${chalk.gray(i.status)}${i.error ? `  ${chalk.red(i.error)}` : ""}\n`,
    );
  }
  for (const n of result.new_imports) {
    process.stdout.write(
      `${chalk.green("+")} ${chalk.bold(n.identifier)} imported → ${chalk.cyan(n.path)}\n`,
    );
  }
  for (const n of result.new_import_errors) {
    process.stdout.write(
      `${chalk.red("✗")} ${chalk.bold(n.identifier)} ${chalk.gray(n.title)} ${chalk.red(n.error)}\n`,
    );
  }
  for (const s of result.skipped_new) {
    process.stdout.write(
      `${chalk.yellow("?")} ${chalk.bold(s.identifier)} ${chalk.gray(s.title)} ${chalk.gray("(remote-only; --include-new to import)")}\n`,
    );
  }
  if (result.remote_scan_error) {
    process.stdout.write(
      `\n${chalk.red("remote-only issue scan failed:")} ${result.remote_scan_error}\n`,
    );
  }
}

function printPatch(patch: string): void {
  process.stdout.write("\n");
  const colored = patch
    .split("\n")
    .map((l) => {
      if (l.startsWith("+++") || l.startsWith("---")) return chalk.bold(l);
      if (l.startsWith("@@")) return chalk.cyan(l);
      if (l.startsWith("+")) return chalk.green(l);
      if (l.startsWith("-")) return chalk.red(l);
      return l;
    })
    .join("\n");
  process.stdout.write(`${colored}\n`);
}

function diffIcon(status: string): string {
  switch (status) {
    case "unchanged":
      return chalk.green("✓");
    case "drift":
      return chalk.yellow("!");
    case "not-yet-applied":
      return chalk.cyan("◦");
    case "missing-remote":
      return chalk.red("✗");
    case "error":
      return chalk.red("✗");
    default:
      return chalk.gray("?");
  }
}

function pullIcon(status: string): string {
  switch (status) {
    case "updated":
      return chalk.green("✓");
    case "unchanged":
      return chalk.gray("·");
    case "skipped-no-id":
      return chalk.cyan("◦");
    case "missing-remote":
      return chalk.red("✗");
    case "error":
      return chalk.red("✗");
    default:
      return chalk.gray("?");
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "created":
      return chalk.green("✓");
    case "created-writeback-failed":
      return chalk.red("✗");
    case "updated-writeback-failed":
      return chalk.red("✗");
    case "updated":
      return chalk.green("✓");
    case "unchanged":
      return chalk.gray("·");
    case "dry-run":
      return chalk.gray("◦");
    case "lint-blocked":
      return chalk.red("✗");
    case "error":
      return chalk.red("✗");
    default:
      return chalk.gray("?");
  }
}
