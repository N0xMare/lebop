import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { writeAtomic } from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import { applyFixesFixpoint, lintContent } from "../lib/lint.ts";
import { applyPlan } from "../lib/planApply.ts";
import { diffPlan } from "../lib/planDiff.ts";
import type { PlanDiffResult } from "../lib/planDiff.ts";
import { parsePlan } from "../lib/planParse.ts";
import { pullPlan } from "../lib/planPull.ts";
import type { ParsedPlan } from "../lib/planTypes.ts";
import { validatePlan } from "../lib/planValidate.ts";
import type { Warning } from "../lib/quirks.ts";
import { getTeamMetadata } from "../lib/resolve.ts";

interface CommonOpts {
  team?: string;
  json?: boolean;
}

interface ApplyCmdOpts extends CommonOpts {
  dryRun?: boolean;
  strict?: boolean;
}

interface PullCmdOpts extends CommonOpts {
  force?: boolean;
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
      const parsed = await parsePlan(dir);
      const team = opts.team ?? parsed.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: team });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      const lintCtx = {
        repoConfig: config.repoConfig,
        workspaceUrlPrefix: config.workspaceUrlPrefix,
      };
      const result = validatePlan(parsed, teamMetadata, lintCtx);

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
      const lintCtx = {
        repoConfig: config.repoConfig,
        workspaceUrlPrefix: config.workspaceUrlPrefix,
      };

      // Fail fast on validation errors; proceed on warnings.
      const validation = validatePlan(parsed, teamMetadata, lintCtx);
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
        lintCtx,
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

  plan
    .command("diff <dir>")
    .description("show drift between plan files and live Linear")
    .option("--team <key>", "override the resolved team")
    .option("--json", "emit structured result")
    .action(async (dir: string, opts: CommonOpts) => {
      const parsed = await parsePlan(dir);
      const team = opts.team ?? parsed.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: team });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      const result = await diffPlan(parsed, teamMetadata);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, ...result }, null, 2)}\n`);
      } else {
        printDiff(result);
      }
      if (result.has_drift) process.exitCode = 1;
    });

  plan
    .command("lint <dir>")
    .description("lint every issue body in a plan directory against repo-scoped rules")
    .option("--team <key>", "override the resolved team")
    .option("--fix", "apply safe autofixes in-place (writes back to the .md files)")
    .option("--strict", "exit non-zero when any warning remains")
    .option("--json", "emit structured result")
    .action(async (dir: string, opts: PlanLintOpts) => {
      const parsed = await parsePlan(dir);
      const team = opts.team ?? parsed.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: team });
      const lintCtx = {
        repoConfig: config.repoConfig,
        workspaceUrlPrefix: config.workspaceUrlPrefix,
      };

      // Collect every `.md` file in the plan dir — the project file + every issue.
      const entries = await readdir(parsed.dir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => join(parsed.dir, e.name));

      const perFile: { path: string; warnings: Warning[]; fixedCount: number }[] = [];
      for (const file of files) {
        if (!existsSync(file)) continue;
        const raw = await Bun.file(file).text();
        // Extract body (after frontmatter) so lint sees only the markdown content.
        const m = raw.match(/^﻿?---\r?\n[\s\S]*?\r?\n?---\r?\n?([\s\S]*)$/);
        const body = (m?.[1] ?? raw).replace(/^\r?\n/, "");
        const head = m ? raw.slice(0, raw.length - body.length) : "";
        const { warnings } = lintContent(body, lintCtx);

        let fixedCount = 0;
        if (opts.fix && warnings.some((w) => w.fix)) {
          const { content: fixedBody } = applyFixesFixpoint(body, lintCtx);
          await writeAtomic(file, `${head}${fixedBody}`);
          fixedCount = warnings.filter((w) => w.fix).length;
        }
        perFile.push({ path: file, warnings, fixedCount });
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              files: perFile.map((f) => ({
                path: f.path,
                warnings: f.warnings,
                fixed: f.fixedCount,
              })),
            },
            null,
            2,
          )}\n`,
        );
      } else {
        let total = 0;
        let fixed = 0;
        for (const f of perFile) {
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
          fixed += f.fixedCount;
        }
        process.stdout.write(
          `\n${chalk.gray(
            `${perFile.length} file(s) checked · ${total} warning(s)${opts.fix ? ` · ${fixed} fixed` : ""}\n`,
          )}`,
        );
      }

      const remaining = perFile.reduce(
        (sum, f) => sum + (f.warnings.length - (opts.fix ? f.fixedCount : 0)),
        0,
      );
      if (opts.strict && remaining > 0) process.exitCode = 1;
    });

  plan
    .command("pull <dir>")
    .description("bring remote Linear state back into plan files (overwrites local)")
    .option("--team <key>", "override the resolved team")
    .option("--force", "pull even if local has drift (overwrites local edits)")
    .option("--include-new", "also import issues that exist on remote but not in the plan")
    .option("--json", "emit structured result")
    .action(async (dir: string, opts: PullCmdOpts) => {
      const parsed = await parsePlan(dir);
      const team = opts.team ?? parsed.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: team });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);

      if (!opts.force) {
        const preDiff = await diffPlan(parsed, teamMetadata);
        if (preDiff.has_drift) {
          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  schema_version: 1,
                  refused: "drift-detected",
                  hint: "run `lebop plan diff` to inspect, then re-run with --force to overwrite local",
                  diff: preDiff,
                },
                null,
                2,
              )}\n`,
            );
          } else {
            process.stderr.write(
              `${chalk.yellow("refusing to pull:")} local plan has drift. Run \`lebop plan diff ${dir}\` to inspect, then \`lebop plan pull ${dir} --force\` to overwrite.\n`,
            );
          }
          process.exitCode = 1;
          return;
        }
      }

      const result = await pullPlan(parsed, teamMetadata, { includeNew: opts.includeNew });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, ...result }, null, 2)}\n`);
      } else {
        printPull(result);
      }

      const hasErrors =
        result.project.status === "error" ||
        result.issues.some((i) => i.status === "error" || i.status === "missing-remote");
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

function printDiff(result: PlanDiffResult): void {
  if (!result.has_drift) {
    process.stdout.write(`${chalk.green("✓")} plan matches Linear — no drift\n`);
    return;
  }

  // Project
  const p = result.project;
  process.stdout.write(
    `${diffIcon(p.status)} project/${chalk.bold(p.name)}  ${chalk.gray(p.status)}\n`,
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
}

function printPull(result: Awaited<ReturnType<typeof pullPlan>>): void {
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
  for (const s of result.skipped_new) {
    process.stdout.write(
      `${chalk.yellow("?")} ${chalk.bold(s.identifier)} ${chalk.gray(s.title)} ${chalk.gray("(remote-only; --include-new to import)")}\n`,
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
