import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { repoCacheDir, writeAtomic } from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import { applyFixesFixpoint, lintContent } from "../lib/lint.ts";
import type { LintContext, Warning } from "../lib/quirks.ts";

interface LintOpts {
  team?: string;
  fix?: boolean;
  strict?: boolean;
  json?: boolean;
}

interface FileResult {
  path: string;
  warnings: Warning[];
  fixedCount: number;
}

export function registerLint(program: Command): void {
  program
    .command("lint [paths...]")
    .description("lint local markdown files for Linear renderer quirks")
    .option("--team <key>", "override the resolved team")
    .option("--fix", "auto-apply safe rewrites")
    .option("--strict", "exit non-zero on any warning")
    .option("--json", "emit structured JSON output")
    .action(async (paths: string[], opts: LintOpts) => {
      const config = await resolveConfig({ teamOverride: opts.team });
      const ctx: LintContext = {
        repoConfig: config.repoConfig,
        workspaceUrlPrefix: config.workspaceUrlPrefix,
      };

      const targetFiles =
        paths.length > 0 ? paths.map((p) => resolvePath(p)) : await collectCacheMarkdown(config);

      if (targetFiles.length === 0) {
        process.stderr.write(`${chalk.yellow("no markdown files found to lint.")}\n`);
        return;
      }

      const fileResults: FileResult[] = [];
      for (const file of targetFiles) {
        if (!existsSync(file)) {
          process.stderr.write(`${chalk.red("missing:")} ${file}\n`);
          continue;
        }
        const content = await Bun.file(file).text();
        const initial = lintContent(content, ctx);

        let fixedCount = 0;
        if (opts.fix && initial.warnings.some((w) => w.fix)) {
          const { content: fixed } = applyFixesFixpoint(content, ctx);
          await writeAtomic(file, fixed);
          fixedCount = initial.warnings.filter((w) => w.fix).length;
        }
        fileResults.push({ path: file, warnings: initial.warnings, fixedCount });
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              files: fileResults.map((f) => ({
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
        printHuman(fileResults, Boolean(opts.fix));
      }

      const remainingWarnings = fileResults.reduce(
        (sum, f) => sum + (f.warnings.length - (opts.fix ? f.fixedCount : 0)),
        0,
      );
      if (opts.strict && remainingWarnings > 0) process.exitCode = 1;
    });
}

function printHuman(results: FileResult[], didFix: boolean): void {
  let totalWarnings = 0;
  let totalFixed = 0;
  for (const r of results) {
    if (r.warnings.length === 0) continue;
    process.stdout.write(`\n${chalk.bold(r.path)}\n`);
    for (const w of r.warnings) {
      const sev =
        w.severity === "warn"
          ? chalk.yellow("warn")
          : w.severity === "error"
            ? chalk.red("error")
            : chalk.gray("info");
      const fixHint = w.fix
        ? didFix
          ? chalk.green(" [fixed]")
          : chalk.gray(" [--fix available]")
        : "";
      process.stdout.write(
        `  ${chalk.dim(`L${w.line}:`)} ${sev} ${chalk.cyan(w.rule)} ${w.message}${fixHint}\n`,
      );
    }
    totalWarnings += r.warnings.length;
    totalFixed += r.fixedCount;
  }

  process.stdout.write(
    `\n${chalk.gray(
      `${results.length} file(s) checked · ${totalWarnings} warning(s)${didFix ? ` · ${totalFixed} fixed` : ""}\n`,
    )}`,
  );
}

/** Walk the repo's cache for `description.md` and `content.md` files. */
async function collectCacheMarkdown(
  config: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<string[]> {
  const root = repoCacheDir(config.repoHash);
  if (!existsSync(root)) return [];

  const files: string[] = [];
  const issuesDir = join(root, "issues");
  if (existsSync(issuesDir)) {
    const issues = await readdir(issuesDir, { withFileTypes: true });
    for (const ent of issues) {
      if (!ent.isDirectory()) continue;
      const desc = join(issuesDir, ent.name, "description.md");
      if (existsSync(desc)) files.push(desc);
    }
  }
  const projectsDir = join(root, "projects");
  if (existsSync(projectsDir)) {
    const projects = await readdir(projectsDir, { withFileTypes: true });
    for (const ent of projects) {
      if (!ent.isDirectory()) continue;
      const cnt = join(projectsDir, ent.name, "content.md");
      if (existsSync(cnt)) files.push(cnt);
    }
  }
  return files;
}
