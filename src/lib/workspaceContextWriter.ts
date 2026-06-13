import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { writeAtomic } from "./cache.ts";
import { ValidationError } from "./errors.ts";
import { CONTEXT_ROOT } from "./paths.ts";
import { safeSegment } from "./workspacePaths.ts";

export interface ContextFile {
  relative: string;
  content: string;
}

export interface WrittenContext {
  root: string;
  manifest_file: string;
  index_file: string;
  summary_file: string;
  recommended_reads: string[];
}

export async function writeWorkspaceContext(input: {
  repoHash: string;
  target: string;
  kind: string;
  index: string;
  summary: unknown;
  manifest: Record<string, unknown>;
  files: ContextFile[];
  recommendedReads?: string[];
  to?: string;
}): Promise<WrittenContext> {
  const root = input.to
    ? resolvePath(input.to)
    : join(
        CONTEXT_ROOT,
        input.repoHash,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeSegment(input.kind)}-${safeSegment(
          input.target,
        )}`,
      );
  const releaseLock = input.to ? await acquireContextRootLock(root) : async () => {};
  try {
    await prepareContextRoot(root, {
      explicit: Boolean(input.to),
      kind: input.kind,
      target: input.target,
    });
    await mkdir(root, { recursive: true });

    const generatedFiles = [
      "index.md",
      "summary.json",
      ...input.files.map((f) => f.relative),
      "manifest.json",
    ];
    const recommendedReads = input.recommendedReads ?? [
      "index.md",
      "summary.json",
      "manifest.json",
    ];
    const generatedSet = new Set(generatedFiles);
    for (const file of generatedFiles) {
      await assertSafeGeneratedPath(root, file);
    }
    for (const file of recommendedReads) {
      await assertSafeGeneratedPath(root, file);
      if (!generatedSet.has(file)) {
        throw new ValidationError(
          `workspace context recommended read was not generated: ${file}`,
          "recommended_reads must reference files written in the same context payload",
        );
      }
    }
    const recommendedSet = new Set(recommendedReads);
    const generatedFileMetadata = generatedFiles.map((file) => ({
      path: file,
      media_type: mediaTypeForGeneratedPath(file),
      role: roleForGeneratedPath(file),
      recommended: recommendedSet.has(file),
    }));
    const manifest = {
      ...input.manifest,
      root,
      context_target: input.target,
      generated_at: new Date().toISOString(),
      context_format: "lebop.linear_workspace_context.v1",
      generated_files: generatedFiles,
      generated_file_metadata: generatedFileMetadata,
      recommended_reads: recommendedReads,
    };

    await writeAtomic(join(root, "index.md"), input.index);
    await writeAtomic(join(root, "summary.json"), `${JSON.stringify(input.summary, null, 2)}\n`);
    for (const file of input.files) {
      await writeAtomic(join(root, file.relative), file.content);
    }
    await writeAtomic(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    return {
      root,
      index_file: join(root, "index.md"),
      summary_file: join(root, "summary.json"),
      manifest_file: join(root, "manifest.json"),
      recommended_reads: recommendedReads,
    };
  } finally {
    await releaseLock();
  }
}

export function markdownJsonBlock(value: unknown): string {
  const json = String(JSON.stringify(value, null, 2));
  const fence = "`".repeat(Math.max(3, longestBacktickRun(json) + 1));
  return `\n\n${fence}json\n${json}\n${fence}\n`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

async function prepareContextRoot(
  root: string,
  input: { explicit: boolean; kind: string; target: string },
): Promise<void> {
  if (!input.explicit) return;

  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink()) {
      throw new ValidationError(
        `refusing to write workspace context into symlinked directory: ${root}`,
        "choose a normal directory for --to",
      );
    }
    if (!rootStat.isDirectory()) {
      throw new ValidationError(
        `refusing to write workspace context into non-directory --to path: ${root}`,
        "choose a directory for --to",
      );
    }
    await assertNoSymlinkedExistingAncestors(root);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    await assertNoSymlinkedExistingAncestors(root);
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  if (entries.length === 0) return;

  const manifestPath = join(root, "manifest.json");
  let manifest: {
    context_format?: string;
    kind?: string;
    target?: string;
    context_target?: string;
    generated_files?: string[];
  };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new ValidationError(
      `refusing to write workspace context into non-empty directory: ${root}`,
      "choose an empty --to directory or a prior lebop workspace context directory for the same target",
    );
  }

  if (
    manifest.context_format !== "lebop.linear_workspace_context.v1" ||
    manifest.kind !== input.kind ||
    (manifest.context_target ?? manifest.target) !== input.target
  ) {
    throw new ValidationError(
      `refusing to overwrite workspace context directory for a different target: ${root}`,
      "choose an empty --to directory or remove the old context directory first",
    );
  }

  if (!Array.isArray(manifest.generated_files)) {
    throw new ValidationError(
      `refusing to reuse old workspace context directory without generated file manifest: ${root}`,
      "choose a new empty --to directory to avoid stale context files",
    );
  }

  for (const file of manifest.generated_files) {
    await assertSafeGeneratedPath(root, file);
    const absolute = resolvePath(root, file);
    await rm(absolute, { force: true, recursive: true });
    await removeEmptyParents(dirname(absolute), root);
  }
}

async function acquireContextRootLock(root: string): Promise<() => Promise<void>> {
  await assertNoSymlinkedExistingAncestors(root);
  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  const lock = join(parent, `.${basename(root)}.lebop-context.lock`);
  try {
    await mkdir(lock);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      throw new ValidationError(
        `workspace context output root is already locked: ${root}`,
        "wait for the other fetch to finish, or remove the stale lock after verifying no lebop process is writing this directory",
      );
    }
    throw err;
  }
  return async () => {
    await rm(lock, { recursive: true, force: true });
  };
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
          `refusing to write workspace context through symlinked ancestor: ${current}`,
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

async function removeEmptyParents(dir: string, root: string): Promise<void> {
  let current = dir;
  while (current !== root && isWithinRoot(root, current)) {
    const entries = await readdir(current).catch(() => null);
    if (!entries || entries.length > 0) return;
    await rm(current, { force: true });
    current = dirname(current);
  }
}

async function assertSafeGeneratedPath(root: string, file: string): Promise<void> {
  if (typeof file !== "string" || file.trim() === "" || file === "." || file === sep) {
    throw new ValidationError(
      `refusing to use root-equivalent workspace context path: ${String(file)}`,
      "generated paths must be relative file paths under the context root",
    );
  }
  const absolute = resolvePath(root, file);
  const rel = relative(root, absolute);
  if (rel === "") {
    throw new ValidationError(
      `refusing to use root-equivalent workspace context path: ${file}`,
      "generated paths must name files, not the context root",
    );
  }
  if (!isWithinRoot(root, absolute)) {
    throw new ValidationError(
      `refusing to write workspace context outside target directory: ${file}`,
      "use relative generated paths that stay inside the context root",
    );
  }
  let current = dirname(absolute);
  const parents: string[] = [];
  while (current !== root && isWithinRoot(root, current)) {
    parents.push(current);
    current = dirname(current);
  }
  for (const parent of parents.reverse()) {
    const stat = await lstat(parent).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new ValidationError(
        `refusing to write workspace context through symlinked directory: ${parent}`,
        "remove the symlink or choose a new empty --to directory",
      );
    }
  }
}

function isWithinRoot(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function mediaTypeForGeneratedPath(file: string): string {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".md")) return "text/markdown";
  return "text/plain";
}

function roleForGeneratedPath(file: string): "index" | "summary" | "manifest" | "context" {
  if (file === "index.md") return "index";
  if (file === "summary.json") return "summary";
  if (file === "manifest.json") return "manifest";
  return "context";
}
