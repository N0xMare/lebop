import { ALL_RULES, type Warning } from "./quirks.ts";

export interface LintResult {
  warnings: Warning[];
}

/** Run every registered rule against `content`. Pure — no I/O. */
export function lintContent(content: string): LintResult {
  const warnings: Warning[] = [];
  for (const rule of ALL_RULES) {
    warnings.push(...rule.check(content));
  }
  // sort by line then rule for stable output
  warnings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return { warnings };
}

/**
 * Apply the autofix for every warning that has one. Fixes are applied bottom-up so earlier
 * fixes don't invalidate later line numbers. Warnings without `fix` are skipped.
 */
export function applyFixes(content: string, warnings: Warning[]): string {
  const fixable = warnings
    .filter((w): w is Warning & { fix: NonNullable<Warning["fix"]> } => Boolean(w.fix))
    .sort((a, b) => b.fix.startLine - a.fix.startLine);

  const lines = content.split("\n");
  for (const w of fixable) {
    const start = w.fix.startLine - 1;
    const end = w.fix.endLine - 1;
    lines.splice(start, end - start + 1, ...w.fix.replacement);
  }
  return lines.join("\n");
}
