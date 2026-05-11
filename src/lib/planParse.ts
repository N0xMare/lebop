import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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
    throw new Error("missing YAML frontmatter (expected `---` … `---` at the top of the file)");
  }
  const yaml = m[1] ?? "";
  // Strip a single leading newline (the conventional blank line after the closing `---`)
  // so re-parse of a writer-generated file yields the same body string round-trip.
  const body = (m[2] ?? "").replace(/^\r?\n/, "");
  const parsed = yaml.trim() === "" ? {} : parseYaml(yaml);
  if (parsed !== null && typeof parsed !== "object") {
    throw new Error("frontmatter YAML must be an object");
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
    throw new Error(`${path}: project frontmatter missing required field \`name\``);
  }
  if (typeof fm.team !== "string" || fm.team.trim() === "") {
    throw new Error(`${path}: project frontmatter missing required field \`team\``);
  }
  return { path, frontmatter: fm, body };
}

/** Parse one issue markdown file. */
async function parseIssueFile(path: string): Promise<IssueFile> {
  const raw = await readFile(path, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = frontmatter as IssueFrontmatter;
  if (typeof fm.title !== "string" || fm.title.trim() === "") {
    throw new Error(`${path}: issue frontmatter missing required field \`title\``);
  }
  const slug = typeof fm.slug === "string" && fm.slug.trim() !== "" ? fm.slug : slugFromPath(path);
  return { path, slug, frontmatter: fm, body };
}

/**
 * Walk a plan directory. Expects:
 * - `_project.md` at top level (required)
 * - `*.md` files for issues (any other markdown files in the dir)
 * - non-`.md` files and nested subdirectories are ignored
 */
export async function parsePlan(dir: string): Promise<ParsedPlan> {
  const absDir = resolve(dir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    throw new Error(`plan directory not found: ${absDir}`);
  }

  const projectPath = join(absDir, "_project.md");
  const hasProject = entries.some((e) => e.isFile() && e.name === "_project.md");
  if (!hasProject) {
    throw new Error(`plan directory missing required \`_project.md\`: ${absDir}`);
  }

  const issuePaths = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "_project.md")
    .map((e) => join(absDir, e.name))
    .sort();

  const project = await parseProjectFile(projectPath);
  const issues: IssueFile[] = [];
  for (const p of issuePaths) {
    issues.push(await parseIssueFile(p));
  }

  return { dir: absDir, project, issues };
}
