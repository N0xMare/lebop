import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { NotFoundError, ValidationError } from "./errors.ts";
import type {
  IssueFile,
  IssueFrontmatter,
  ParsedPlan,
  ProjectFile,
  ProjectFrontmatter,
} from "./planTypes.ts";

/** Parse a frontmatter+body markdown file into {frontmatter, body}. */
export function splitFrontmatter(raw: string): { frontmatter: unknown; body: string } {
  // Accept optional leading BOM, then `---\n`, yaml (possibly empty), `---\n?`, then body.
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/);
  if (!m) {
    throw new ValidationError(
      "missing YAML frontmatter (expected `---` … `---` at the top of the file)",
      "wrap the frontmatter block between two `---` lines at the top of the file",
    );
  }
  const yaml = m[1] ?? "";
  // Strip a single leading newline (the conventional blank line after the closing `---`)
  // so re-parse of a writer-generated file yields the same body string round-trip.
  const body = (m[2] ?? "").replace(/^\r?\n/, "");
  const parsed = yaml.trim() === "" ? {} : parseYaml(yaml);
  if (parsed !== null && typeof parsed !== "object") {
    throw new ValidationError(
      "frontmatter YAML must be an object",
      "use `key: value` pairs in the frontmatter block, not a bare scalar",
    );
  }
  return { frontmatter: parsed ?? {}, body };
}

/** Derive the default slug for an issue file (filename stem, lowercased). */
export function slugFromPath(path: string): string {
  const base = basename(path);
  return base.replace(/\.md$/i, "");
}

/** Parse the `_project.md` file in a plan directory. */
async function parseProjectFile(path: string): Promise<ProjectFile> {
  const raw = await readFile(path, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = frontmatter as ProjectFrontmatter;
  if (typeof fm.name !== "string" || fm.name.trim() === "") {
    throw new ValidationError(
      `${path}: project frontmatter missing required field \`name\``,
      "add a non-empty `name:` field to the project frontmatter",
    );
  }
  if (typeof fm.team !== "string" || fm.team.trim() === "") {
    throw new ValidationError(
      `${path}: project frontmatter missing required field \`team\``,
      "add a `team:` field (e.g. `team: UE`) to the project frontmatter",
    );
  }
  return { path, frontmatter: fm, body };
}

/** Parse one issue markdown file. */
async function parseIssueFile(path: string): Promise<IssueFile> {
  const raw = await readFile(path, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = frontmatter as IssueFrontmatter;
  if (typeof fm.title !== "string" || fm.title.trim() === "") {
    throw new ValidationError(
      `${path}: issue frontmatter missing required field \`title\``,
      "add a non-empty `title:` field to the issue frontmatter",
    );
  }
  const slug = typeof fm.slug === "string" && fm.slug.trim() !== "" ? fm.slug : slugFromPath(path);
  return { path, slug, frontmatter: fm, body };
}

/**
 * Walk a plan directory. Expects:
 * - `_project.md` at top level (required)
 * - `*.md` files for issues (any other markdown files in the dir)
 * - non-`.md` files and nested subdirectories are ignored
 * - documentation-only filenames are skipped explicitly: `README.md`,
 *   `README.txt`, `CHANGELOG.md`, `NOTES.md`. Plan dirs can carry
 *   sibling docs (especially in the shipped examples) without tripping
 *   "missing YAML frontmatter" errors.
 */
export async function parsePlan(dir: string): Promise<ParsedPlan> {
  const absDir = resolve(dir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    throw new NotFoundError(
      `plan directory not found: ${absDir}`,
      "pass a path to an existing directory containing a `_project.md`",
    );
  }

  const projectPath = join(absDir, "_project.md");
  const hasProject = entries.some((e) => e.isFile() && e.name === "_project.md");
  if (!hasProject) {
    throw new ValidationError(
      `plan directory missing required \`_project.md\`: ${absDir}`,
      "create a `_project.md` with at least `name:` and `team:` frontmatter",
    );
  }

  // Documentation-only meta filenames that should NEVER be parsed as
  // plan issues. Keeping this explicit (instead of skipping any file
  // without frontmatter) avoids silently dropping a user's mis-formatted
  // issue file — they'll still see a "missing frontmatter" error.
  const META_FILENAMES = new Set(["README.md", "README.txt", "CHANGELOG.md", "NOTES.md"]);

  const issuePaths = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".md") &&
        e.name !== "_project.md" &&
        !META_FILENAMES.has(e.name),
    )
    .map((e) => join(absDir, e.name))
    .sort();

  const project = await parseProjectFile(projectPath);
  const issues: IssueFile[] = [];
  for (const p of issuePaths) {
    issues.push(await parseIssueFile(p));
  }

  return { dir: absDir, project, issues };
}
