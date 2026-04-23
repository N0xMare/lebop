import type { TeamMetadata } from "./cache.ts";
import { lintContent } from "./lint.ts";
import {
  LINK_KEYS,
  type LinkKey,
  type ParsedPlan,
  type PlanError,
  type PlanWarning,
  type ValidationResult,
} from "./planTypes.ts";
import type { LintContext } from "./quirks.ts";
import { resolveLabelId, resolvePriority, resolveStateId } from "./resolve.ts";

/** TEAM-NN format. */
const LINEAR_ID_RE = /^[A-Z]+-\d+$/;

const isLinearId = (s: string): boolean => LINEAR_ID_RE.test(s);

/**
 * Validate a parsed plan. Pass `teamMetadata` for full semantic checks (label/state/
 * assignee resolution). Pass `null` for syntactic-only validation.
 */
export function validatePlan(
  plan: ParsedPlan,
  teamMetadata: TeamMetadata | null,
  lintCtx: LintContext = {},
): ValidationResult {
  const errors: PlanError[] = [];
  const warnings: PlanWarning[] = [];

  // ---------- 1. Slug uniqueness ----------
  const slugCounts = new Map<string, string[]>();
  for (const issue of plan.issues) {
    const list = slugCounts.get(issue.slug) ?? [];
    list.push(issue.path);
    slugCounts.set(issue.slug, list);
  }
  for (const [slug, paths] of slugCounts) {
    if (paths.length > 1) {
      errors.push({
        message: `duplicate slug "${slug}" used by ${paths.length} files: ${paths.join(", ")}`,
      });
    }
  }

  // ---------- 2. Slug-matches-LinearID warning ----------
  for (const issue of plan.issues) {
    if (isLinearId(issue.slug)) {
      warnings.push({
        path: issue.path,
        rule: "slug-shadow",
        message: `slug "${issue.slug}" matches the Linear identifier regex. Link references to it will be treated as EXTERNAL. Rename or set an explicit \`slug:\` in frontmatter.`,
      });
    }
  }

  // ---------- 3. Link reference resolution ----------
  const slugs = new Set(plan.issues.map((i) => i.slug));
  for (const issue of plan.issues) {
    for (const key of LINK_KEYS) {
      const targets = issue.frontmatter[key] as string[] | undefined;
      if (!targets) continue;
      if (!Array.isArray(targets)) {
        errors.push({
          path: issue.path,
          message: `\`${key}:\` must be a list of strings`,
        });
        continue;
      }
      for (const target of targets) {
        if (typeof target !== "string" || target.trim() === "") {
          errors.push({
            path: issue.path,
            message: `\`${key}:\` contains an empty or non-string entry`,
          });
          continue;
        }
        if (isLinearId(target)) continue; // external — accepted syntactically
        if (!slugs.has(target)) {
          errors.push({
            path: issue.path,
            message: `\`${key}: ${target}\` doesn't match any slug in this plan and isn't a Linear identifier (TEAM-NN format)`,
          });
        }
      }
    }
  }

  // ---------- 4. Cycle detection on blocks/blocked_by graph ----------
  const cycles = findBlocksCycles(plan);
  for (const cycle of cycles) {
    warnings.push({
      rule: "blocks-cycle",
      message: `cycle in blocks graph: ${cycle.join(" → ")} → ${cycle[0]}`,
    });
  }

  // ---------- 5. Duplicate-link side-effect warning ----------
  for (const issue of plan.issues) {
    const dup = (issue.frontmatter.duplicates as string[] | undefined) ?? [];
    const dupBy = (issue.frontmatter.duplicated_by as string[] | undefined) ?? [];
    if (dup.length > 0 || dupBy.length > 0) {
      warnings.push({
        path: issue.path,
        rule: "duplicate-side-effect",
        message:
          "`duplicates:` / `duplicated_by:` will move involved issues to state `Duplicate` (Linear workflow side-effect). Remove these entries or confirm the intent.",
      });
    }
  }

  // ---------- 6. Lint bodies ----------
  for (const issue of plan.issues) {
    const { warnings: lintWs } = lintContent(issue.body, lintCtx);
    for (const w of lintWs) {
      warnings.push({
        path: issue.path,
        rule: w.rule,
        message: `line ${w.line}: ${w.message}`,
      });
    }
  }
  if (plan.project.body.trim() !== "") {
    const { warnings: lintWs } = lintContent(plan.project.body, lintCtx);
    for (const w of lintWs) {
      warnings.push({
        path: plan.project.path,
        rule: w.rule,
        message: `line ${w.line}: ${w.message}`,
      });
    }
  }

  // ---------- 7. Semantic checks (network-dependent) ----------
  if (teamMetadata) {
    for (const issue of plan.issues) {
      const fm = issue.frontmatter;
      if (fm.state) {
        try {
          resolveStateId(teamMetadata, fm.state);
        } catch (err) {
          errors.push({ path: issue.path, message: (err as Error).message });
        }
      }
      if (fm.priority !== undefined) {
        try {
          resolvePriority(fm.priority);
        } catch (err) {
          errors.push({ path: issue.path, message: (err as Error).message });
        }
      }
      if (fm.labels) {
        for (const label of fm.labels) {
          try {
            resolveLabelId(teamMetadata, label);
          } catch (err) {
            errors.push({ path: issue.path, message: (err as Error).message });
          }
        }
      }
      // assignee: resolveAssigneeId is async (hits viewer for @me); defer to apply time.
    }
  }

  return { errors, warnings };
}

/** Find cycles in the forward-edges implied by `blocks:` + inverses of `blocked_by:`. */
function findBlocksCycles(plan: ParsedPlan): string[][] {
  const slugOf = new Map<string, string>(); // slug → canonical slug (trivial here)
  for (const i of plan.issues) slugOf.set(i.slug, i.slug);

  const edges = new Map<string, Set<string>>();
  for (const issue of plan.issues) edges.set(issue.slug, new Set());

  for (const issue of plan.issues) {
    const blocks = ((issue.frontmatter.blocks as string[] | undefined) ?? []).filter(
      (t) => !isLinearId(t) && slugOf.has(t),
    );
    for (const t of blocks) edges.get(issue.slug)?.add(t);

    const blockedBy = ((issue.frontmatter.blocked_by as string[] | undefined) ?? []).filter(
      (t) => !isLinearId(t) && slugOf.has(t),
    );
    for (const from of blockedBy) {
      if (!edges.has(from)) edges.set(from, new Set());
      edges.get(from)?.add(issue.slug);
    }
  }

  // DFS, record cycles.
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    if (done.has(node)) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      if (start !== -1) cycles.push(stack.slice(start));
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    stack.pop();
    visiting.delete(node);
    done.add(node);
  };

  for (const node of edges.keys()) visit(node);
  return cycles;
}
