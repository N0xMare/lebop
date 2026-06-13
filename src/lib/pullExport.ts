import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { CachedComment, IssueMetadata, ProjectMetadata } from "./cache.ts";
import { commentFileName, writeAtomic } from "./cache.ts";
import { ValidationError } from "./errors.ts";
import { ISSUE_IDENTIFIER_PATTERN } from "./issueIdentifiers.ts";

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export async function preparePullExportRoot(root: string): Promise<void> {
  const stat = await lstat(root).catch(() => null);
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new ValidationError(
        `refusing to export through symlinked --to directory: ${root}`,
        "choose a normal directory for --to",
      );
    }
    if (!stat.isDirectory()) {
      throw new ValidationError(
        `refusing to export into non-directory --to path: ${root}`,
        "choose a directory for --to",
      );
    }
    await assertNoSymlinkedExistingAncestors(root);
    return;
  }
  await assertNoSymlinkedExistingAncestors(root);
}

export async function writeIssueExport(
  destinationRoot: string,
  identifier: string,
  metadata: IssueMetadata,
  description: string,
  comments: CachedComment[],
): Promise<string> {
  const dir = resolveConfinedExportDir(destinationRoot, identifier, {
    label: "issue identifier",
    pattern: ISSUE_IDENTIFIER_PATTERN,
  });
  await assertNotSymlink(dir, "issue export directory");
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, "description.md"), description);
  await writeAtomic(join(dir, "metadata.yaml"), stringifyYaml(metadata, { lineWidth: 0 }));
  const commentsDir = join(dir, "comments");
  await assertNotSymlink(commentsDir, "comments export directory");
  await rm(commentsDir, { recursive: true, force: true });
  if (comments.length > 0) {
    await mkdir(commentsDir, { recursive: true });
    for (const c of comments) {
      const text = `---\n${stringifyYaml(c.frontmatter)}---\n\n${c.body}\n`;
      await writeAtomic(join(commentsDir, commentFileName(c.frontmatter.id)), text);
    }
  }
  return dir;
}

export async function writeProjectExport(
  destinationRoot: string,
  projectId: string,
  metadata: ProjectMetadata,
  content: string,
): Promise<string> {
  const dir = resolveConfinedExportDir(destinationRoot, `project-${projectId}`, {
    rawValue: projectId,
    label: "project id",
    pattern: PROJECT_ID_PATTERN,
  });
  await assertNotSymlink(dir, "project export directory");
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, "content.md"), content);
  await writeAtomic(join(dir, "metadata.yaml"), stringifyYaml(metadata));
  return dir;
}

function resolveConfinedExportDir(
  destinationRoot: string,
  segment: string,
  input: { label: string; pattern: RegExp; rawValue?: string },
): string {
  const value = input.rawValue ?? segment;
  if (
    !input.pattern.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    /^\.+$/.test(value)
  ) {
    throw new ValidationError(
      `invalid export ${input.label}: ${value}`,
      "export paths must use canonical Linear identifiers without path separators",
    );
  }

  const root = resolvePath(destinationRoot);
  const dir = resolvePath(root, segment);
  if (!isWithinRoot(root, dir)) {
    throw new ValidationError(
      `export path escapes destination root: ${segment}`,
      "export paths must resolve under the --to directory",
    );
  }
  return dir;
}

function isWithinRoot(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\");
}

async function assertNotSymlink(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (stat?.isSymbolicLink()) {
    throw new ValidationError(
      `refusing to export through symlinked ${label}: ${path}`,
      "remove the symlink or choose a new --to directory",
    );
  }
}

async function assertNoSymlinkedExistingAncestors(root: string): Promise<void> {
  let current = dirname(root);
  const checked = new Set<string>();
  while (!checked.has(current)) {
    checked.add(current);
    const stat = await lstat(current).catch(() => null);
    if (stat) {
      if (stat.isSymbolicLink()) {
        if (dirname(current) === dirname(dirname(current))) return;
        throw new ValidationError(
          `refusing to export through symlinked ancestor: ${current}`,
          "choose a normal directory for --to",
        );
      }
      current = dirname(current);
      continue;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
