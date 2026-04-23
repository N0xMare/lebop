/**
 * Shared types for the `leebop plan` feature. See `docs/plan-spec.md` for the
 * full frontmatter schema and apply semantics.
 */

export type LinkKey = "blocks" | "blocked_by" | "related" | "duplicates" | "duplicated_by";

export const LINK_KEYS: readonly LinkKey[] = [
  "blocks",
  "blocked_by",
  "related",
  "duplicates",
  "duplicated_by",
] as const;

/** Maps our snake_case YAML key to the 5-kind directional surface `set links` uses. */
export const LINK_KEY_TO_SET_LINKS_KIND: Record<
  LinkKey,
  "blocks" | "blocked-by" | "related" | "duplicates" | "duplicated-by"
> = {
  blocks: "blocks",
  blocked_by: "blocked-by",
  related: "related",
  duplicates: "duplicates",
  duplicated_by: "duplicated-by",
};

export interface IssueFrontmatter {
  title: string;
  linear_id?: string; // "UE-401"; written back after first apply
  state?: string;
  priority?: string | number;
  labels?: string[];
  assignee?: string | null;
  slug?: string; // explicit override; default = filename stem
  blocks?: string[];
  blocked_by?: string[];
  related?: string[];
  duplicates?: string[];
  duplicated_by?: string[];
  [key: string]: unknown; // tolerant to unrecognised fields — captured but ignored
}

export interface ProjectFrontmatter {
  name: string;
  team: string;
  linear_id?: string; // UUID; written back after first apply
  description?: string;
  state?: string;
  [key: string]: unknown;
}

export interface IssueFile {
  /** absolute path to the .md file */
  path: string;
  /** filename stem, or explicit `slug:` if present */
  slug: string;
  frontmatter: IssueFrontmatter;
  body: string;
}

export interface ProjectFile {
  path: string;
  frontmatter: ProjectFrontmatter;
  body: string;
}

export interface ParsedPlan {
  /** absolute path to the plan dir */
  dir: string;
  project: ProjectFile;
  issues: IssueFile[];
}

export interface PlanError {
  path?: string;
  message: string;
}

export interface PlanWarning {
  path?: string;
  rule: string;
  message: string;
}

export interface ValidationResult {
  errors: PlanError[];
  warnings: PlanWarning[];
}
