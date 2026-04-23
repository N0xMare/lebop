import { ALL_RULES, type LintContext, type Warning } from "./quirks.ts";

export interface LintResult {
  warnings: Warning[];
}

/**
 * Run every registered rule against `content`. Pure — no I/O.
 * `ctx` carries repo-scoped config for repo-aware rules (L004/R001/R002); universal
 * rules ignore it. Omit to run universal-only.
 */
export function lintContent(content: string, ctx: LintContext = {}): LintResult {
  const warnings: Warning[] = [];
  for (const rule of ALL_RULES) {
    warnings.push(...rule.check(content, ctx));
  }
  // sort by line then rule for stable output
  warnings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return { warnings };
}

/**
 * Apply autofixes once. Fixes are applied bottom-up so earlier fixes don't invalidate
 * later line numbers. When multiple warnings target the SAME line range, only the first
 * is applied — their rules each produced a "fixed line" computed from the pre-fix
 * content, so naive composition would have later rules' outputs overwrite earlier ones.
 * The caller (`applyFixesFixpoint`) iterates so skipped fixes fire on the next pass
 * against the updated content.
 */
export function applyFixes(content: string, warnings: Warning[]): string {
  const fixable = warnings
    .filter((w): w is Warning & { fix: NonNullable<Warning["fix"]> } => Boolean(w.fix))
    .sort((a, b) => b.fix.startLine - a.fix.startLine);

  // Keep at most one fix per line-range. Rule-ordering is stable from lintContent's sort.
  const seen = new Set<string>();
  const deduped: typeof fixable = [];
  for (const w of fixable) {
    const key = `${w.fix.startLine}-${w.fix.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(w);
  }

  const lines = content.split("\n");
  for (const w of deduped) {
    const start = w.fix.startLine - 1;
    const end = w.fix.endLine - 1;
    lines.splice(start, end - start + 1, ...w.fix.replacement);
  }
  return lines.join("\n");
}

/**
 * Run lint + applyFixes repeatedly until the content is stable or `maxPasses` is hit.
 * Needed because multiple rules can flag the same line, and applyFixes only lands one
 * fix per line per pass — successive passes re-lint the fixed content and apply the
 * remaining rules' fixes against the updated state.
 */
export function applyFixesFixpoint(
  content: string,
  ctx: LintContext = {},
  maxPasses = 10,
): { content: string; warnings: Warning[]; passes: number } {
  let current = content;
  for (let i = 0; i < maxPasses; i++) {
    const { warnings } = lintContent(current, ctx);
    const fixable = warnings.filter((w) => w.fix);
    if (fixable.length === 0) return { content: current, warnings, passes: i };
    const next = applyFixes(current, warnings);
    if (next === current) return { content: current, warnings, passes: i };
    current = next;
  }
  const { warnings } = lintContent(current, ctx);
  return { content: current, warnings, passes: maxPasses };
}
