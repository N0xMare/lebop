import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { repoCacheDir, writeAtomic } from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { ConfigError } from "../lib/errors.ts";
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
      // Lint is structurally team-independent for the universal rules
      // (L001-L006). Team-scoped rules (R001-R002 repo-scoped, L004
      // bracket-issue-refs) degrade gracefully with an empty repoConfig +
      // no workspaceUrlPrefix. So when explicit paths are passed AND no
      // team can be resolved, fall back to a minimal context rather than
      // failing the whole invocation. Cache-mode (no paths) still
      // requires a resolved team since `collectCacheMarkdown` needs the
      // repoHash from config.
      let ctx: LintContext;
      let cacheConfig: Awaited<ReturnType<typeof resolveConfig>> | null = null;
      try {
        const config = await resolveConfig({ teamOverride: opts.team });
        ctx = {
          repoConfig: config.repoConfig,
          workspaceUrlPrefix: config.workspaceUrlPrefix,
        };
        cacheConfig = config;
      } catch (err) {
        if (err instanceof ConfigError && paths.length > 0) {
          ctx = { repoConfig: {}, workspaceUrlPrefix: undefined };
        } else {
          // Either a non-ConfigError, or cache-mode (no paths) which
          // genuinely needs a configured team for repoHash resolution.
          throw err;
        }
      }

      const targetFiles =
        paths.length > 0
          ? paths.map((p) => resolvePath(p))
          : cacheConfig
            ? await collectCacheMarkdown(cacheConfig)
            : [];

      if (targetFiles.length === 0) {
        process.stderr.write(`${chalk.yellow("no markdown files found to lint.")}\n`);
        return;
      }

      const fileResults: FileResult[] = [];
      let missingCount = 0;
      for (const file of targetFiles) {
        if (!existsSync(file)) {
          process.stderr.write(`${chalk.red("missing:")} ${file}\n`);
          missingCount += 1;
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

      // UX papercut guard (round-5 fix): if EVERY explicit path failed the
      // existence check, the human-mode output would silently say
      // "0 file(s) checked · 0 warning(s)" — confusing given the per-file
      // "missing:" stderr lines above. Emit a clear summary + exit 1 so
      // CI gates catch this as a failure, not a clean pass.
      if (paths.length > 0 && missingCount === paths.length && fileResults.length === 0) {
        process.stderr.write(
          `${chalk.red("error:")} no files linted — all ${missingCount} explicit path(s) were missing.\n` +
            `  ${chalk.cyan("hint:")} verify the path(s); lint exits 1 when no input files were readable.\n`,
        );
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              files: fileResults.map((f) => ({
                path: f.path,
                warnings: f.warnings,
                fixed: f.fixedCount,
              })),
            }),
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
