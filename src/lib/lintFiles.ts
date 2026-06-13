import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { repoCacheDir, writeAtomic } from "./cache.ts";
import { type ResolvedConfig, resolveConfig } from "./config.ts";
import { ConfigError, ValidationError } from "./errors.ts";
import { applyFixesFixpoint, lintContent } from "./lint.ts";
import type { LintContext, Warning } from "./quirks.ts";

export interface LintFilesInput {
  paths?: string[];
  team?: string;
  fix?: boolean;
  strict?: boolean;
  repoRoot?: string;
}

export interface LintFileResult {
  path: string;
  warnings: Warning[];
  fixed: number;
}

export interface LintFilesResult {
  files: LintFileResult[];
  warning_count: number;
  fixed_count: number;
  missing_count: number;
  missing_paths: string[];
  strict_failed: boolean;
  cache_mode: boolean;
}

export async function lintFiles(input: LintFilesInput): Promise<LintFilesResult> {
  const paths = input.paths ?? [];
  const explicitPaths = paths.length > 0;
  let ctx: LintContext;
  let cacheConfig: ResolvedConfig | null = null;
  try {
    const config = await resolveConfig({
      cwd: input.repoRoot,
      teamOverride: input.team,
      requireGitRoot: Boolean(input.repoRoot),
    });
    ctx = {
      repoConfig: config.repoConfig,
      workspaceUrlPrefix: config.workspaceUrlPrefix,
    };
    cacheConfig = config;
  } catch (err) {
    if (err instanceof ConfigError && explicitPaths) {
      ctx = { repoConfig: {}, workspaceUrlPrefix: undefined };
    } else {
      throw err;
    }
  }

  const baseDir = input.repoRoot ? resolvePath(input.repoRoot) : process.cwd();
  const targetFiles = explicitPaths
    ? paths.map((path) => resolvePath(baseDir, path))
    : cacheConfig
      ? await collectCacheMarkdown(cacheConfig)
      : [];

  const fileResults: LintFileResult[] = [];
  let missingCount = 0;
  const missingPaths: string[] = [];
  for (const file of targetFiles) {
    if (!existsSync(file)) {
      missingCount += 1;
      missingPaths.push(file);
      continue;
    }
    const content = await Bun.file(file).text();
    const initial = lintContent(content, ctx);

    let warnings = initial.warnings;
    let fixedCount = 0;
    if (input.fix === true && initial.warnings.some((warning) => warning.fix)) {
      const fixedResult = applyFixesFixpoint(content, ctx);
      if (fixedResult.content !== content) {
        await writeAtomic(file, fixedResult.content);
        fixedCount = initial.warnings.filter((warning) => warning.fix).length;
      }
      warnings = fixedResult.warnings;
    }
    fileResults.push({ path: file, warnings, fixed: fixedCount });
  }

  if (explicitPaths && missingCount === paths.length && fileResults.length === 0) {
    throw new ValidationError(
      `no files linted; all ${missingCount} explicit path(s) were missing`,
      "verify the path(s); lint exits 1 when no input files are readable",
    );
  }

  const warningCount = fileResults.reduce((sum, file) => sum + file.warnings.length, 0);
  const fixedCount = fileResults.reduce((sum, file) => sum + file.fixed, 0);

  return {
    files: fileResults,
    warning_count: warningCount,
    fixed_count: fixedCount,
    missing_count: missingCount,
    missing_paths: missingPaths,
    strict_failed: input.strict === true && warningCount > 0,
    cache_mode: !explicitPaths,
  };
}

/** Walk the repo's cache for `description.md` and `content.md` files. */
async function collectCacheMarkdown(config: ResolvedConfig): Promise<string[]> {
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
