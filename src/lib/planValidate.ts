import type { TeamMetadata } from "./cache.ts";
import { assertIconNotEmoji } from "./icons.ts";
import { isIssueIdentifier } from "./issueIdentifiers.ts";
import { lintContent } from "./lint.ts";
import {
  ISSUE_FRONTMATTER_KEYS,
  LINK_KEYS,
  type LinkKey,
  type ParsedPlan,
  type PlanError,
  type PlanWarning,
  PROJECT_FRONTMATTER_KEYS,
  type ValidationResult,
} from "./planTypes.ts";
import type { LintContext } from "./quirks.ts";
import { getTeamMetadata, resolveLabelId, resolvePriority, resolveStateId } from "./resolve.ts";

const isLinearId = (s: string): boolean => isIssueIdentifier(s);
const PROJECT_ALLOWED_KEYS = new Set(PROJECT_FRONTMATTER_KEYS);
const ISSUE_ALLOWED_KEYS = new Set(ISSUE_FRONTMATTER_KEYS);

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

  validateFrontmatterKeys(
    "project",
    plan.project.path,
    plan.project.frontmatter,
    PROJECT_ALLOWED_KEYS,
    errors,
  );
  for (const issue of plan.issues) {
    validateFrontmatterKeys("issue", issue.path, issue.frontmatter, ISSUE_ALLOWED_KEYS, errors);
  }
  validateProjectFrontmatterTypes(plan.project.path, plan.project.frontmatter, errors);
  for (const issue of plan.issues) {
    validateIssueFrontmatterTypes(issue.path, issue.frontmatter, errors);
  }

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

  // ---------- 1b. Project icon validation ----------
  if (typeof plan.project.frontmatter.icon === "string") {
    try {
      assertIconNotEmoji(plan.project.frontmatter.icon);
    } catch (err) {
      errors.push({ path: plan.project.path, message: (err as Error).message });
    }
  }
  validateOptionalDateField(
    "project",
    plan.project.path,
    "start_date",
    plan.project.frontmatter.start_date,
    errors,
  );
  validateOptionalDateField(
    "project",
    plan.project.path,
    "target_date",
    plan.project.frontmatter.target_date,
    errors,
  );

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
  const issueIdentities = buildIssueIdentityMap(plan);
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
        if (issueIdentities.has(target)) continue;
        if (isLinearId(target)) continue; // external — accepted syntactically
        if (!issueIdentities.has(target)) {
          errors.push({
            path: issue.path,
            message: `\`${key}: ${target}\` doesn't match any slug in this plan and isn't a Linear identifier (TEAM-NN format)`,
          });
        }
      }
    }
  }

  // ---------- 4. Cycle detection on blocks/blocked_by graph ----------
  const cycles = findBlocksCycles(plan, issueIdentities);
  for (const cycle of cycles) {
    warnings.push({
      rule: "blocks-cycle",
      message: `cycle in blocks graph: ${cycle.join(" → ")} → ${cycle[0]}`,
    });
  }

  // ---------- 4b. parent reference resolution + cycle detection ----------
  for (const issue of plan.issues) {
    const p = issue.frontmatter.parent;
    if (p === undefined || p === null) continue;
    if (typeof p !== "string" || p.trim() === "") {
      errors.push({ path: issue.path, message: "`parent:` must be a non-empty string" });
      continue;
    }
    if (!issueIdentities.has(p) && !isLinearId(p)) {
      errors.push({
        path: issue.path,
        message: `\`parent: ${p}\` doesn't match any slug in this plan and isn't a Linear identifier`,
      });
    }
  }
  const parentCycles = findParentCycles(plan, issueIdentities);
  for (const cycle of parentCycles) {
    errors.push({
      message: `cycle in parent chain: ${cycle.join(" → ")} → ${cycle[0]}`,
    });
  }

  // ---------- 4c. Same-pair multi-type relation conflict ----------
  // Linear stores at most one relation record per (issueA, issueB) pair —
  // declaring two different kinds (e.g. A.blocks: [B] and B.related: [A])
  // means the second `apply` call silently overwrites the first. Warn at
  // validate time so the plan author can pick one.
  type RelationApiType = "blocks" | "duplicate" | "related";
  const KIND_TO_API_TYPE: Record<LinkKey, RelationApiType> = {
    blocks: "blocks",
    blocked_by: "blocks",
    related: "related",
    duplicates: "duplicate",
    duplicated_by: "duplicate",
  };
  const pairDeclarations = new Map<string, Set<RelationApiType>>();
  const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const issue of plan.issues) {
    const source = issueIdentities.get(issue.slug) ?? issue.slug;
    for (const key of LINK_KEYS) {
      const targets = (issue.frontmatter[key] as string[] | undefined) ?? [];
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        if (typeof target !== "string" || target.trim() === "") continue;
        const targetKey = issueIdentities.get(target) ?? target;
        const pair = pairKey(source, targetKey);
        const apiType = KIND_TO_API_TYPE[key];
        const types = pairDeclarations.get(pair) ?? new Set<RelationApiType>();
        types.add(apiType);
        pairDeclarations.set(pair, types);
      }
    }
  }
  for (const [pair, types] of pairDeclarations) {
    if (types.size > 1) {
      const [a, b] = pair.split("|");
      errors.push({
        message: `multiple relation kinds declared between "${a}" and "${b}" (${[...types].join(", ")}). Linear stores one relation per pair — later declarations silently overwrite earlier ones during apply. Pick one kind.`,
      });
    }
  }

  // ---------- 4d. Opposite directional blockers ----------
  // A.blocks: [B] and B.blocked_by: [A] are equivalent declarations of the
  // same relation. A.blocks: [B] and B.blocks: [A] are contradictory.
  const blockDirections = new Map<string, Set<string>>();
  for (const issue of plan.issues) {
    const source = issueIdentities.get(issue.slug) ?? issue.slug;
    for (const key of ["blocks", "blocked_by"] as const) {
      const targets = (issue.frontmatter[key] as string[] | undefined) ?? [];
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        if (typeof target !== "string" || target.trim() === "") continue;
        const targetKey = issueIdentities.get(target) ?? target;
        const blocker = key === "blocks" ? source : targetKey;
        const blocked = key === "blocks" ? targetKey : source;
        const pair = pairKey(blocker, blocked);
        const directions = blockDirections.get(pair) ?? new Set<string>();
        directions.add(`${blocker}->${blocked}`);
        blockDirections.set(pair, directions);
      }
    }
  }
  for (const [pair, directions] of blockDirections) {
    if (directions.size > 1) {
      const [a, b] = pair.split("|");
      errors.push({
        message: `opposite blocker relations declared between "${a}" and "${b}". A pair cannot both block and be blocked by each other; keep only one direction.`,
      });
    }
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
          "`duplicates:` / `duplicated_by:` can move involved issues to state `Duplicate` when creating a new Linear relation. Existing pulled duplicate relations are allowed to round-trip; new duplicate relation creation is blocked during apply/publish unless explicitly supported by that write path.",
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
      if (typeof fm.state === "string" && fm.state.trim() !== "") {
        try {
          resolveStateId(teamMetadata, fm.state);
        } catch (err) {
          errors.push({ path: issue.path, message: (err as Error).message });
        }
      }
      if (typeof fm.priority === "string" || typeof fm.priority === "number") {
        try {
          resolvePriority(fm.priority);
        } catch (err) {
          errors.push({ path: issue.path, message: (err as Error).message });
        }
      }
      if (Array.isArray(fm.labels) && fm.labels.every((label) => typeof label === "string")) {
        for (const label of fm.labels) {
          try {
            resolveLabelId(teamMetadata, label);
          } catch (err) {
            errors.push({ path: issue.path, message: (err as Error).message });
          }
        }
      }
      if (typeof fm.assignee === "string") {
        const message = validateAssigneeFromMetadata(teamMetadata, fm.assignee);
        if (message) {
          errors.push({ path: issue.path, message });
        }
      }
    }
  }

  return { errors, warnings };
}

function validateFrontmatterKeys(
  kind: "project" | "issue",
  path: string,
  frontmatter: object,
  allowed: Set<string>,
  errors: PlanError[],
): void {
  for (const key of Object.keys(frontmatter)) {
    if (allowed.has(key) || key.startsWith("x_")) continue;
    errors.push({
      path,
      message: `unsupported ${kind} frontmatter field: ${key}`,
    });
  }
}

function validateProjectFrontmatterTypes(
  path: string,
  frontmatter: Record<string, unknown>,
  errors: PlanError[],
): void {
  validateRequiredStringFrontmatter(path, "project", "name", frontmatter.name, errors);
  validateRequiredStringFrontmatter(path, "project", "team", frontmatter.team, errors);
  validateOptionalStringFrontmatter(path, "project", "linear_id", frontmatter.linear_id, errors);
  validateOptionalServerSnapshot(path, "project", frontmatter._server, errors);
  validateOptionalStringFrontmatter(
    path,
    "project",
    "description",
    frontmatter.description,
    errors,
  );
  validateOptionalNullableStringFrontmatter(path, "project", "icon", frontmatter.icon, errors);
  validateOptionalStringFrontmatter(path, "project", "state", frontmatter.state, errors);
}

function validateIssueFrontmatterTypes(
  path: string,
  frontmatter: Record<string, unknown>,
  errors: PlanError[],
): void {
  validateRequiredStringFrontmatter(path, "issue", "title", frontmatter.title, errors);
  validateOptionalStringFrontmatter(path, "issue", "linear_id", frontmatter.linear_id, errors);
  validateOptionalServerSnapshot(path, "issue", frontmatter._server, errors);
  validateOptionalStringFrontmatter(path, "issue", "state", frontmatter.state, errors);
  validateOptionalPriorityFrontmatter(path, frontmatter.priority, errors);
  validateOptionalNumberFrontmatter(path, "issue", "estimate", frontmatter.estimate, errors);
  validateOptionalStringArrayFrontmatter(path, "labels", frontmatter.labels, errors);
  validateOptionalNullableStringFrontmatter(
    path,
    "issue",
    "assignee",
    frontmatter.assignee,
    errors,
  );
  validateOptionalStringFrontmatter(path, "issue", "slug", frontmatter.slug, errors);
}

function validateRequiredStringFrontmatter(
  path: string,
  kind: "project" | "issue",
  field: string,
  value: unknown,
  errors: PlanError[],
): void {
  if (typeof value === "string" && value.trim() !== "") return;
  errors.push({
    path,
    message: `${kind} frontmatter field \`${field}\` must be a non-empty string`,
  });
}

function validateOptionalStringFrontmatter(
  path: string,
  kind: "project" | "issue",
  field: string,
  value: unknown,
  errors: PlanError[],
): void {
  if (value === undefined || typeof value === "string") return;
  errors.push({
    path,
    message: `${kind} frontmatter field \`${field}\` must be a string`,
  });
}

function validateOptionalNullableStringFrontmatter(
  path: string,
  kind: "project" | "issue",
  field: string,
  value: unknown,
  errors: PlanError[],
): void {
  if (value === undefined || value === null || typeof value === "string") return;
  errors.push({
    path,
    message: `${kind} frontmatter field \`${field}\` must be a string or null`,
  });
}

function validateOptionalNumberFrontmatter(
  path: string,
  kind: "issue",
  field: string,
  value: unknown,
  errors: PlanError[],
): void {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  errors.push({
    path,
    message: `${kind} frontmatter field \`${field}\` must be a number or null`,
  });
}

function validateOptionalPriorityFrontmatter(
  path: string,
  value: unknown,
  errors: PlanError[],
): void {
  if (value === undefined || typeof value === "string" || typeof value === "number") return;
  errors.push({
    path,
    message: "issue frontmatter field `priority` must be a string or number",
  });
}

function validateOptionalStringArrayFrontmatter(
  path: string,
  field: string,
  value: unknown,
  errors: PlanError[],
): void {
  if (value === undefined) return;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return;
  errors.push({
    path,
    message: `\`${field}:\` must be a list of strings`,
  });
}

function validateOptionalServerSnapshot(
  path: string,
  kind: "project" | "issue",
  value: unknown,
  errors: PlanError[],
): void {
  if (value === undefined) return;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const updatedAt = (value as { updated_at?: unknown }).updated_at;
    if (updatedAt !== undefined && typeof updatedAt !== "string") {
      errors.push({
        path,
        message: `${kind} frontmatter field \`_server.updated_at\` must be a string`,
      });
    }
    return;
  }
  errors.push({
    path,
    message: `${kind} frontmatter field \`_server\` must be an object`,
  });
}

function validateOptionalDateField(
  kind: "project" | "issue",
  path: string,
  field: string,
  value: unknown,
  errors: PlanError[],
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({
      path,
      message: `${kind} frontmatter field \`${field}\` must be a YYYY-MM-DD string or null`,
    });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push({
      path,
      message: `${kind} frontmatter field \`${field}\` must use YYYY-MM-DD format`,
    });
  }
}

export async function validatePlanWithFreshTeamMetadata(
  plan: ParsedPlan,
  input: { repoHash: string; team: string; lintCtx?: LintContext },
): Promise<{ teamMetadata: TeamMetadata; validation: ValidationResult }> {
  let teamMetadata = await getTeamMetadata(input.repoHash, input.team);
  let validation = validatePlan(plan, teamMetadata, input.lintCtx ?? {});
  if (planValidationHasMetadataMiss(validation)) {
    teamMetadata = await getTeamMetadata(input.repoHash, input.team, { refresh: true });
    validation = validatePlan(plan, teamMetadata, input.lintCtx ?? {});
  }
  return { teamMetadata, validation };
}

function planValidationHasMetadataMiss(result: ValidationResult): boolean {
  return result.errors.some((error) =>
    /^(unknown state|unknown label|unknown assignee)\b/.test(error.message),
  );
}

/**
 * Detect cycles in the `parent:` chain. Each issue has at most one parent, so this is a
 * simpler walk than the blocks DAG — follow `parent` pointers until we either hit an
 * external identifier, fall off the plan, or revisit a node (cycle).
 */
function findParentCycles(plan: ParsedPlan, identities: Map<string, string>): string[][] {
  const bySlug = new Map<string, string | undefined>();
  for (const i of plan.issues) {
    const parent =
      typeof i.frontmatter.parent === "string" ? identities.get(i.frontmatter.parent) : undefined;
    bySlug.set(i.slug, parent);
  }

  const cycles: string[][] = [];
  const done = new Set<string>();
  for (const [start] of bySlug) {
    if (done.has(start)) continue;
    const stack: string[] = [];
    const seen = new Set<string>();
    let node: string | undefined = start;
    while (node) {
      if (seen.has(node)) {
        const idx = stack.indexOf(node);
        if (idx !== -1) cycles.push(stack.slice(idx));
        break;
      }
      seen.add(node);
      stack.push(node);
      if (!bySlug.has(node)) break; // external ref — ends the chain cleanly
      node = bySlug.get(node);
    }
    for (const n of stack) done.add(n);
  }
  // Dedupe cycles (same cycle may be found from different starts).
  const unique: string[][] = [];
  const seen = new Set<string>();
  for (const c of cycles) {
    const key = [...c].sort().join("|");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }
  return unique;
}

/** Find cycles in the forward-edges implied by `blocks:` + inverses of `blocked_by:`. */
function findBlocksCycles(plan: ParsedPlan, identities: Map<string, string>): string[][] {
  const edges = new Map<string, Set<string>>();
  for (const issue of plan.issues) edges.set(issue.slug, new Set());

  for (const issue of plan.issues) {
    const blocks = stringArray(issue.frontmatter.blocks).filter((t) => identities.has(t));
    for (const t of blocks) {
      const target = identities.get(t);
      if (target) edges.get(issue.slug)?.add(target);
    }

    const blockedBy = stringArray(issue.frontmatter.blocked_by).filter((t) => identities.has(t));
    for (const from of blockedBy) {
      const source = identities.get(from);
      if (!source) continue;
      if (!edges.has(source)) edges.set(source, new Set());
      edges.get(source)?.add(issue.slug);
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function buildIssueIdentityMap(plan: ParsedPlan): Map<string, string> {
  const identities = new Map<string, string>();
  for (const issue of plan.issues) {
    identities.set(issue.slug, issue.slug);
    const id = issue.frontmatter.linear_id;
    if (typeof id === "string" && id.trim() !== "") {
      identities.set(id, issue.slug);
    }
  }
  return identities;
}

function validateAssigneeFromMetadata(metadata: TeamMetadata, who: string): string | null {
  if (who === "null" || who === "none" || who === "" || who === "@me" || who === "me") {
    return null;
  }

  const needle = who.toLowerCase();
  if (metadata.members.some((m) => m.email.toLowerCase() === needle)) return null;
  if (metadata.members.some((m) => m.name.toLowerCase() === needle)) return null;

  const prefixMatches = metadata.members.filter(
    (m) => m.email.toLowerCase().startsWith(needle) || m.name.toLowerCase().startsWith(needle),
  );
  if (prefixMatches.length === 1) return null;
  if (prefixMatches.length > 1) {
    const candidates = prefixMatches.map((m) => `${m.name} <${m.email}>`).join(", ");
    return `ambiguous assignee "${who}" matches: ${candidates}`;
  }

  return `unknown assignee "${who}" — no member match by email or name`;
}
