import { existsSync } from "node:fs";
import { writeAtomic } from "./cache.ts";
import { applyFixesFixpoint, lintContent } from "./lint.ts";
import type { ParsedPlan } from "./planTypes.ts";
import type { LintContext, Warning } from "./quirks.ts";

export interface PlanLintFileResult {
  path: string;
  warnings: Warning[];
  fixed: number;
}

export async function lintPlanFiles(
  parsed: ParsedPlan,
  opts: { fix?: boolean; lintCtx?: LintContext } = {},
): Promise<PlanLintFileResult[]> {
  const lintCtx = opts.lintCtx ?? {};
  const files = [parsed.project.path, ...parsed.issues.map((issue) => issue.path)];

  const perFile: PlanLintFileResult[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const raw = await Bun.file(file).text();
    const match = raw.match(/^﻿?---\r?\n[\s\S]*?\r?\n?---\r?\n?([\s\S]*)$/);
    const body = (match?.[1] ?? raw).replace(/^\r?\n/, "");
    const head = match ? raw.slice(0, raw.length - body.length) : "";
    const { warnings: originalWarnings } = lintContent(body, lintCtx);

    let warnings = originalWarnings;
    let fixed = 0;
    if (opts.fix && originalWarnings.some((warning) => warning.fix)) {
      const fixedResult = applyFixesFixpoint(body, lintCtx);
      await writeAtomic(file, `${head}${fixedResult.content}`);
      fixed = originalWarnings.filter((warning) => warning.fix).length;
      warnings = fixedResult.warnings;
    }
    perFile.push({ path: file, warnings, fixed });
  }

  return perFile;
}

export function countRemainingPlanLintWarnings(files: PlanLintFileResult[], _fix: boolean): number {
  return files.reduce((sum, file) => sum + file.warnings.length, 0);
}
