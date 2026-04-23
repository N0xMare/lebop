import chalk from "chalk";
import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { applyPlan } from "../lib/planApply.ts";
import { parsePlan } from "../lib/planParse.ts";
import type { ParsedPlan } from "../lib/planTypes.ts";
import { validatePlan } from "../lib/planValidate.ts";
import { getTeamMetadata } from "../lib/resolve.ts";

interface CommonOpts {
  team?: string;
  json?: boolean;
}

interface ApplyCmdOpts extends CommonOpts {
  dryRun?: boolean;
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
      const parsed = await parsePlan(dir);
      const team = opts.team ?? parsed.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: team });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      const result = validatePlan(parsed, teamMetadata);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ schema_version: 1, ...summarizeParse(parsed), ...result }, null, 2)}\n`,
        );
      } else {
        printValidate(parsed, result);
      }
      if (result.errors.length > 0) process.exitCode = 1;
    });

  plan
    .command("apply <dir>")
    .description("create/update the project + issues + links described by the plan")
    .option("--team <key>", "override the resolved team")
    .option("--dry-run", "print the plan without writing to Linear")
    .option("--strict", "block any issue whose body has lint warnings")
    .option("--json", "emit structured result")
    .action(async (dir: string, opts: ApplyCmdOpts) => {
      const parsed = await parsePlan(dir);
      const team = opts.team ?? parsed.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: team });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);

      // Fail fast on validation errors; proceed on warnings.
      const validation = validatePlan(parsed, teamMetadata);
      if (validation.errors.length > 0) {
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ schema_version: 1, validation }, null, 2)}\n`);
        } else {
          printValidate(parsed, validation);
        }
        process.exitCode = 1;
        return;
      }

      // Surface warnings non-fatally.
      if (validation.warnings.length > 0 && !opts.json) {
        printWarnings(validation.warnings);
      }

      const result = await applyPlan(parsed, teamMetadata, {
        dryRun: opts.dryRun,
        strict: opts.strict,
      });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ schema_version: 1, dry_run: !!opts.dryRun, ...result }, null, 2)}\n`,
        );
      } else {
        printApply(result, !!opts.dryRun);
      }

      const hasErrors =
        result.project.status === "error" ||
        result.issues.some((i) => i.status === "error" || i.status === "lint-blocked") ||
        result.relations.some((r) => r.status === "error");
      if (hasErrors) process.exitCode = 1;
    });
}

function summarizeParse(plan: ParsedPlan) {
  return {
    dir: plan.dir,
    project: {
      name: plan.project.frontmatter.name,
      linear_id: plan.project.frontmatter.linear_id ?? null,
    },
    issues: plan.issues.map((i) => ({
      slug: i.slug,
      title: i.frontmatter.title,
      linear_id: i.frontmatter.linear_id ?? null,
    })),
  };
}

function printValidate(parsed: ParsedPlan, result: ReturnType<typeof validatePlan>): void {
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

function printWarnings(warnings: ReturnType<typeof validatePlan>["warnings"]): void {
  process.stdout.write(`\n${chalk.yellow(`${warnings.length} warning(s):`)}\n`);
  for (const w of warnings) {
    const loc = w.path ? `${chalk.gray(w.path)}: ` : "";
    process.stdout.write(`  ${chalk.yellow("!")} ${loc}${chalk.cyan(w.rule)} ${w.message}\n`);
  }
}

function printApply(result: Awaited<ReturnType<typeof applyPlan>>, dryRun: boolean): void {
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

function statusIcon(status: string): string {
  switch (status) {
    case "created":
      return chalk.green("✓");
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
