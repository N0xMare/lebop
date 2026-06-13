import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
import { parseDocument, parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { findGitRoot, hashRepoRoot } from "./config.ts";
import { ValidationError } from "./errors.ts";
import { ISSUE_IDENTIFIER_PATTERN } from "./issueIdentifiers.ts";
import { CACHE_ROOT } from "./paths.ts";
import {
  assertNoSymlinkedExistingAncestorsSync,
  ensureStateDirectoryForWrite,
} from "./stateSafety.ts";

export interface ServerSnapshot {
  id: string;
  identifier: string;
  url: string;
  state_id: string;
  state_name: string;
  state_type: string;
  priority: number;
  estimate: number | null;
  label_ids: { id: string; name: string }[];
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  title: string;
  description_hash: string;
  project_id: string | null;
  project_name: string | null;
  project_milestone_id: string | null;
  project_milestone_name: string | null;
  cycle_id: string | null;
  cycle_name: string | null;
  parent_id: string | null;
  parent_identifier: string | null;
  updated_at: string;
}

export interface IssueMetadata {
  identifier: string;
  title: string;
  state: string;
  priority: number;
  estimate: number | null;
  labels: string[];
  assignee: string | null;
  project: string | null;
  milestone: string | null;
  cycle: string | null;
  parent: string | null;
  _server: ServerSnapshot;
}

export interface CommentFrontmatter {
  id: string;
  author: string;
  author_name: string;
  created_at: string;
  updated_at: string;
}

export interface CachedComment {
  frontmatter: CommentFrontmatter;
  body: string;
}

export interface ProjectServerSnapshot {
  id: string;
  url: string;
  state: string;
  name: string;
  description: string;
  icon: string | null;
  start_date: string | null;
  target_date: string | null;
  content_hash: string;
  updated_at: string;
}

export interface ProjectMetadata {
  name: string;
  description: string;
  icon: string | null;
  start_date: string | null;
  target_date: string | null;
  state: string;
  _server: ProjectServerSnapshot;
}

export interface CacheIntegrityProblem {
  kind: "issue" | "project";
  id: string;
  path: string;
  problem: "invalid-key" | "incomplete-row" | "invalid-metadata";
  missing_files: string[];
  repair_hint: string;
}

export type ConditionalCacheWriteResult<T> =
  | { status: "missing" }
  | { status: "guard-failed"; current: T }
  | { status: "written" };

// ---------- paths ----------

export function repoCacheDir(repoHash: string): string {
  assertCacheKey("repo hash", repoHash, /^(_global|[a-f0-9]{12})$/);
  return confineCachePath(CACHE_ROOT, repoHash);
}

export function issueDir(repoHash: string, identifier: string): string {
  assertCacheKey("issue identifier", identifier, ISSUE_IDENTIFIER_PATTERN);
  return confineCachePath(repoCacheDir(repoHash), "issues", identifier);
}

export function projectDir(repoHash: string, projectId: string): string {
  assertCacheKey("project id", projectId, /^[a-zA-Z0-9._-]+$/);
  return confineCachePath(repoCacheDir(repoHash), "projects", projectId);
}

export function teamCacheFile(repoHash: string, teamKey: string): string {
  assertCacheKey("team key", teamKey, /^[A-Z][A-Z0-9]*$/);
  return confineCachePath(repoCacheDir(repoHash), "_team", `${teamKey}.yaml`);
}

const SAFE_COMMENT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_SAFE_COMMENT_ID_FILENAME_LENGTH = 120;

export function commentFileName(commentId: string): string {
  if (commentId.length === 0) {
    throw new ValidationError(
      "invalid cache comment id: empty",
      "comment ids must be non-empty Linear identifiers",
    );
  }
  if (
    SAFE_COMMENT_ID_PATTERN.test(commentId) &&
    commentId.length <= MAX_SAFE_COMMENT_ID_FILENAME_LENGTH &&
    !/^\.+$/.test(commentId)
  ) {
    return `${commentId}.md`;
  }
  return `comment-${sha256(commentId).slice(0, 32)}.md`;
}

function assertCacheKey(label: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value) || value.includes("/") || value.includes("\\") || /^\.+$/.test(value)) {
    throw new ValidationError(
      `invalid cache ${label}: ${value}`,
      "cache keys must be canonical Linear identifiers and cannot contain path separators",
    );
  }
}

function confineCachePath(root: string, ...segments: string[]): string {
  const absoluteRoot = resolvePath(root);
  const candidate = resolvePath(root, ...segments);
  const rel = relative(absoluteRoot, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new ValidationError(
      `cache path escapes expected root: ${segments.join("/")}`,
      "cache keys must resolve under lebop's cache directory",
    );
  }
  return candidate;
}

// ---------- atomic write ----------

let writeAtomicCounter = 0;

export async function writeAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${writeAtomicCounter++}`;
  await Bun.write(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup so a failed rename (cross-fs, permission, etc.)
    // doesn't leak `.tmp-<pid>-<ts>` files in the parent dir forever.
    try {
      unlinkSync(tmp);
    } catch {
      // Tmp already gone, or unreadable — fall through. The thrown rename
      // error is the user-actionable signal; suppress the cleanup failure.
    }
    throw err;
  }
}

// ---------- hashing ----------

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------- issue read/write ----------

const CACHE_ROW_LOCK_TIMEOUT_MS = 30_000;
const CACHE_ROW_LOCK_POLL_MS = 25;

function cacheRowLockDir(rowDir: string): string {
  return join(dirname(rowDir), `.${basename(rowDir)}.lebop-row.lock`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireCacheRowLock(rowDir: string): Promise<() => Promise<void>> {
  ensureCacheDirectoryForWrite(rowDir);
  await mkdir(dirname(rowDir), { recursive: true });
  const lockDir = cacheRowLockDir(rowDir);
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") throw err;
      if (Date.now() - started > CACHE_ROW_LOCK_TIMEOUT_MS) {
        throw new ValidationError(
          `cache row is locked: ${rowDir}`,
          "wait for the other lebop process to finish, or remove the stale row lock after verifying no process is writing it",
        );
      }
      await sleep(CACHE_ROW_LOCK_POLL_MS);
    }
  }
}

async function waitForCacheRowUnlock(rowDir: string): Promise<void> {
  const lockDir = cacheRowLockDir(rowDir);
  const started = Date.now();
  while (existsSync(lockDir)) {
    if (Date.now() - started > CACHE_ROW_LOCK_TIMEOUT_MS) {
      throw new ValidationError(
        `cache row is locked: ${rowDir}`,
        "wait for the other lebop process to finish, or remove the stale row lock after verifying no process is writing it",
      );
    }
    await sleep(CACHE_ROW_LOCK_POLL_MS);
  }
}

async function withCacheRowLock<T>(rowDir: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireCacheRowLock(rowDir);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function writeIssue(
  repoHash: string,
  metadata: IssueMetadata,
  description: string,
): Promise<void> {
  const dir = issueDir(repoHash, metadata.identifier);
  await withCacheRowLock(dir, async () => {
    await writeIssueUnlocked(repoHash, metadata, description);
  });
}

export async function writeIssueIfCurrent(
  repoHash: string,
  identifier: string,
  guard: (current: { metadata: IssueMetadata; description: string }) => boolean,
  metadata: IssueMetadata,
  description: string,
): Promise<ConditionalCacheWriteResult<{ metadata: IssueMetadata; description: string }>> {
  const dir = issueDir(repoHash, identifier);
  return withCacheRowLock(dir, async () => {
    const current = await readIssueUnlocked(repoHash, identifier);
    if (!current) return { status: "missing" };
    if (!guard(current)) return { status: "guard-failed", current };
    await writeIssueUnlocked(repoHash, metadata, description);
    return { status: "written" };
  });
}

async function writeIssueUnlocked(
  repoHash: string,
  metadata: IssueMetadata,
  description: string,
): Promise<void> {
  const dir = issueDir(repoHash, metadata.identifier);
  ensureCacheDirectoryForWrite(dir);
  mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, "metadata.yaml");
  const descPath = join(dir, "description.md");
  await writeAtomic(descPath, description);
  await writeAtomic(metaPath, serializeIssueMetadata(metadata));
}

export async function writeIssueWithComments(
  repoHash: string,
  metadata: IssueMetadata,
  description: string,
  comments: CachedComment[],
  opts: { refreshComments: boolean },
): Promise<void> {
  const dir = issueDir(repoHash, metadata.identifier);
  await withCacheRowLock(dir, async () => {
    await writeIssueUnlocked(repoHash, metadata, description);
    await clearCommentsUnlocked(repoHash, metadata.identifier);
    if (opts.refreshComments) {
      for (const comment of comments) {
        await writeCommentUnlocked(repoHash, metadata.identifier, comment);
      }
    }
  });
}

export async function readIssue(
  repoHash: string,
  identifier: string,
): Promise<{ metadata: IssueMetadata; description: string } | null> {
  const dir = issueDir(repoHash, identifier);
  await waitForCacheRowUnlock(dir);
  return readIssueUnlocked(repoHash, identifier);
}

async function readIssueUnlocked(
  repoHash: string,
  identifier: string,
): Promise<{ metadata: IssueMetadata; description: string } | null> {
  const dir = issueDir(repoHash, identifier);
  const metaPath = join(dir, "metadata.yaml");
  const descPath = join(dir, "description.md");
  if (!existsSync(metaPath) || !existsSync(descPath)) return null;
  const metaText = await Bun.file(metaPath).text();
  const metadata = validateIssueMetadata(
    normalizeIssueMetadata(parseYaml(metaText)),
    `issue cache metadata for ${identifier}`,
  );
  assertIssueCacheIdentity(identifier, metadata);
  const description = await Bun.file(descPath).text();
  return { metadata, description };
}

export async function listCachedIssues(repoHash: string): Promise<string[]> {
  const dir = join(repoCacheDir(repoHash), "issues");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => ISSUE_IDENTIFIER_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();
}

export async function listCachedProjectIds(repoHash: string): Promise<string[]> {
  const dir = join(repoCacheDir(repoHash), "projects");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => /^[a-zA-Z0-9._-]+$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

export async function inspectCacheIntegrity(repoHash: string): Promise<CacheIntegrityProblem[]> {
  const problems: CacheIntegrityProblem[] = [];
  const issueRoot = join(repoCacheDir(repoHash), "issues");
  if (existsSync(issueRoot)) {
    for (const entry of await readdir(issueRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(issueRoot, entry.name);
      if (!ISSUE_IDENTIFIER_PATTERN.test(entry.name)) {
        problems.push({
          kind: "issue",
          id: entry.name,
          path,
          problem: "invalid-key",
          missing_files: [],
          repair_hint:
            "remove the invalid cache directory manually; issue cache directories must use canonical identifiers like TEAM-123",
        });
        continue;
      }
      const missing = ["metadata.yaml", "description.md"].filter(
        (file) => !existsSync(join(path, file)),
      );
      if (missing.length > 0) {
        problems.push({
          kind: "issue",
          id: entry.name,
          path,
          problem: "incomplete-row",
          missing_files: missing,
          repair_hint: `run \`lebop pull ${entry.name} --refresh --yes\` to rebuild this cache row after verifying local cache overwrite is intended`,
        });
      } else {
        const metadataProblem = await inspectMetadataYaml({
          kind: "issue",
          id: entry.name,
          path,
          file: "metadata.yaml",
          repairHint: `run \`lebop pull ${entry.name} --refresh --yes\` to rebuild this cache row after verifying local cache overwrite is intended`,
        });
        if (metadataProblem) problems.push(metadataProblem);
      }
    }
  }

  const projectRoot = join(repoCacheDir(repoHash), "projects");
  if (existsSync(projectRoot)) {
    for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(projectRoot, entry.name);
      if (!/^[a-zA-Z0-9._-]+$/.test(entry.name)) {
        problems.push({
          kind: "project",
          id: entry.name,
          path,
          problem: "invalid-key",
          missing_files: [],
          repair_hint:
            "remove the invalid cache directory manually; project cache directories must use Linear project ids",
        });
        continue;
      }
      const missing = ["metadata.yaml", "content.md"].filter(
        (file) => !existsSync(join(path, file)),
      );
      if (missing.length > 0) {
        problems.push({
          kind: "project",
          id: entry.name,
          path,
          problem: "incomplete-row",
          missing_files: missing,
          repair_hint:
            "run `lebop pull --project-id <id> --refresh --yes` to rebuild this project cache row after verifying local cache overwrite is intended",
        });
      } else {
        const metadataProblem = await inspectMetadataYaml({
          kind: "project",
          id: entry.name,
          path,
          file: "metadata.yaml",
          repairHint:
            "run `lebop pull --project-id <id> --refresh --yes` to rebuild this project cache row after verifying local cache overwrite is intended",
        });
        if (metadataProblem) problems.push(metadataProblem);
      }
    }
  }

  return problems.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

async function inspectMetadataYaml(input: {
  kind: "issue" | "project";
  id: string;
  path: string;
  file: string;
  repairHint: string;
}): Promise<CacheIntegrityProblem | null> {
  const metadataPath = join(input.path, input.file);
  try {
    const raw = await readFile(metadataPath, "utf8");
    const doc = parseDocument(raw);
    if (doc.errors.length > 0) throw new Error(doc.errors[0]?.message ?? "invalid YAML");
    const value = doc.toJS();
    if (input.kind === "issue") {
      validateIssueMetadata(value, `issue cache metadata for ${input.id}`);
    } else {
      validateProjectMetadata(value, `project cache metadata for ${input.id}`);
    }
    return null;
  } catch {
    // Fall through to the normalized integrity problem below.
  }
  return {
    kind: input.kind,
    id: input.id,
    path: input.path,
    problem: "invalid-metadata",
    missing_files: [],
    repair_hint: input.repairHint,
  };
}

// ---------- project read/write ----------

export async function writeProject(
  repoHash: string,
  metadata: ProjectMetadata,
  content: string,
): Promise<void> {
  const dir = projectDir(repoHash, metadata._server.id);
  await withCacheRowLock(dir, async () => {
    await writeProjectUnlocked(repoHash, metadata, content);
  });
}

export async function writeProjectIfCurrent(
  repoHash: string,
  projectId: string,
  guard: (current: { metadata: ProjectMetadata; content: string }) => boolean,
  metadata: ProjectMetadata,
  content: string,
): Promise<ConditionalCacheWriteResult<{ metadata: ProjectMetadata; content: string }>> {
  const dir = projectDir(repoHash, projectId);
  return withCacheRowLock(dir, async () => {
    const current = await readProjectUnlocked(repoHash, projectId);
    if (!current) return { status: "missing" };
    if (!guard(current)) return { status: "guard-failed", current };
    await writeProjectUnlocked(repoHash, metadata, content);
    return { status: "written" };
  });
}

async function writeProjectUnlocked(
  repoHash: string,
  metadata: ProjectMetadata,
  content: string,
): Promise<void> {
  const dir = projectDir(repoHash, metadata._server.id);
  ensureCacheDirectoryForWrite(dir);
  mkdirSync(dir, { recursive: true });
  await writeAtomic(join(dir, "content.md"), content);
  await writeAtomic(join(dir, "metadata.yaml"), stringifyYaml(metadata));
}

export async function readProject(
  repoHash: string,
  projectId: string,
): Promise<{ metadata: ProjectMetadata; content: string } | null> {
  const dir = projectDir(repoHash, projectId);
  await waitForCacheRowUnlock(dir);
  return readProjectUnlocked(repoHash, projectId);
}

async function readProjectUnlocked(
  repoHash: string,
  projectId: string,
): Promise<{ metadata: ProjectMetadata; content: string } | null> {
  const dir = projectDir(repoHash, projectId);
  const metaPath = join(dir, "metadata.yaml");
  const contentPath = join(dir, "content.md");
  if (!existsSync(metaPath) || !existsSync(contentPath)) return null;
  const metaText = await Bun.file(metaPath).text();
  const metadata = validateProjectMetadata(
    normalizeProjectMetadata(parseYaml(metaText)),
    `project cache metadata for ${projectId}`,
  );
  assertProjectCacheIdentity(projectId, metadata);
  const content = await Bun.file(contentPath).text();
  return { metadata, content };
}

function assertIssueCacheIdentity(identifier: string, metadata: IssueMetadata): void {
  const expected = identifier.toUpperCase();
  const actual = metadata.identifier.toUpperCase();
  const serverActual = metadata._server.identifier.toUpperCase();
  if (actual !== expected || serverActual !== expected) {
    throw new ValidationError(
      `cache issue identity mismatch for ${identifier}`,
      `metadata.identifier and _server.identifier must both be ${expected}; rebuild this row with \`lebop pull ${expected} --refresh --yes\` after verifying local cache overwrite is intended`,
    );
  }
}

function assertProjectCacheIdentity(projectId: string, metadata: ProjectMetadata): void {
  if (metadata._server.id !== projectId) {
    throw new ValidationError(
      `cache project identity mismatch for ${projectId}`,
      `metadata._server.id must be ${projectId}; rebuild this row with \`lebop pull --project-id ${projectId} --refresh --yes\` after verifying local cache overwrite is intended`,
    );
  }
}

function normalizeIssueMetadata(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const metadata = value;
  metadata.milestone ??= null;
  metadata.cycle ??= null;
  if (isRecord(metadata._server)) {
    metadata._server.project_milestone_id ??= null;
    metadata._server.project_milestone_name ??= null;
    metadata._server.cycle_id ??= null;
    metadata._server.cycle_name ??= null;
  }
  return metadata;
}

function validateIssueMetadata(value: unknown, context: string): IssueMetadata {
  const metadata = requireRecord(normalizeIssueMetadata(value), context);
  requireString(metadata, "identifier", context);
  requireString(metadata, "title", context);
  requireString(metadata, "state", context);
  requireNumber(metadata, "priority", context);
  requireNullableNumber(metadata, "estimate", context);
  requireStringArray(metadata, "labels", context);
  requireNullableString(metadata, "assignee", context);
  requireNullableString(metadata, "project", context);
  requireNullableString(metadata, "milestone", context);
  requireNullableString(metadata, "cycle", context);
  requireNullableString(metadata, "parent", context);
  validateIssueServerSnapshot(metadata._server, `${context}._server`);
  return metadata as unknown as IssueMetadata;
}

function validateIssueServerSnapshot(value: unknown, context: string): void {
  const snapshot = requireRecord(value, context);
  for (const field of [
    "id",
    "identifier",
    "url",
    "state_id",
    "state_name",
    "state_type",
    "title",
    "description_hash",
    "updated_at",
  ]) {
    requireString(snapshot, field, context);
  }
  requireNumber(snapshot, "priority", context);
  requireNullableNumber(snapshot, "estimate", context);
  requireLabelIdArray(snapshot, "label_ids", context);
  for (const field of [
    "assignee_id",
    "assignee_name",
    "assignee_email",
    "project_id",
    "project_name",
    "project_milestone_id",
    "project_milestone_name",
    "cycle_id",
    "cycle_name",
    "parent_id",
    "parent_identifier",
  ]) {
    requireNullableString(snapshot, field, context);
  }
}

function normalizeProjectMetadata(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const metadata = value;
  metadata.icon ??= null;
  metadata.start_date ??= null;
  metadata.target_date ??= null;
  if (isRecord(metadata._server)) {
    metadata._server.icon ??= null;
    metadata._server.start_date ??= null;
    metadata._server.target_date ??= null;
  }
  return metadata;
}

function validateProjectMetadata(value: unknown, context: string): ProjectMetadata {
  const metadata = requireRecord(normalizeProjectMetadata(value), context);
  requireString(metadata, "name", context);
  requireString(metadata, "description", context);
  requireNullableString(metadata, "icon", context);
  requireNullableString(metadata, "start_date", context);
  requireNullableString(metadata, "target_date", context);
  requireString(metadata, "state", context);
  validateProjectServerSnapshot(metadata._server, `${context}._server`);
  return metadata as unknown as ProjectMetadata;
}

function validateProjectServerSnapshot(value: unknown, context: string): void {
  const snapshot = requireRecord(value, context);
  for (const field of ["id", "url", "state", "name", "description", "content_hash", "updated_at"]) {
    requireString(snapshot, field, context);
  }
  requireNullableString(snapshot, "icon", context);
  requireNullableString(snapshot, "start_date", context);
  requireNullableString(snapshot, "target_date", context);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ValidationError(
      `${context} must be a YAML object`,
      "rebuild the cache row with `lebop pull --refresh --yes` after verifying local cache overwrite is intended",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string, context: string): void {
  if (typeof record[field] !== "string") {
    throw invalidMetadataField(context, field, "string");
  }
}

function requireNullableString(
  record: Record<string, unknown>,
  field: string,
  context: string,
): void {
  const value = record[field];
  if (value !== null && typeof value !== "string") {
    throw invalidMetadataField(context, field, "string or null");
  }
}

function requireNumber(record: Record<string, unknown>, field: string, context: string): void {
  if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
    throw invalidMetadataField(context, field, "number");
  }
}

function requireNullableNumber(
  record: Record<string, unknown>,
  field: string,
  context: string,
): void {
  const value = record[field];
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw invalidMetadataField(context, field, "number or null");
  }
}

function requireStringArray(record: Record<string, unknown>, field: string, context: string): void {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw invalidMetadataField(context, field, "string[]");
  }
}

function requireLabelIdArray(
  record: Record<string, unknown>,
  field: string,
  context: string,
): void {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => {
      if (!isRecord(entry)) return false;
      return typeof entry.id === "string" && typeof entry.name === "string";
    })
  ) {
    throw invalidMetadataField(context, field, "{id:string,name:string}[]");
  }
}

function invalidMetadataField(context: string, field: string, expected: string): ValidationError {
  return new ValidationError(
    `${context} has invalid field \`${field}\``,
    `expected ${expected}; rebuild the cache row with \`lebop pull --refresh --yes\` after verifying local cache overwrite is intended`,
  );
}

// ---------- comments ----------

export async function writeComment(
  repoHash: string,
  issueId: string,
  comment: CachedComment,
): Promise<void> {
  await writeCommentUnlocked(repoHash, issueId, comment);
}

async function writeCommentUnlocked(
  repoHash: string,
  issueId: string,
  comment: CachedComment,
): Promise<void> {
  const dir = join(issueDir(repoHash, issueId), "comments");
  ensureCacheDirectoryForWrite(dir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, commentFileName(comment.frontmatter.id));
  const text = `---\n${stringifyYaml(comment.frontmatter)}---\n\n${comment.body}\n`;
  await writeAtomic(file, text);
}

export async function clearComments(repoHash: string, issueId: string): Promise<void> {
  await clearCommentsUnlocked(repoHash, issueId);
}

async function clearCommentsUnlocked(repoHash: string, issueId: string): Promise<void> {
  const dir = join(issueDir(repoHash, issueId), "comments");
  if (!existsSync(dir)) return;
  await rm(dir, { recursive: true, force: true });
}

// ---------- serialization ----------

function serializeIssueMetadata(metadata: IssueMetadata): string {
  // yaml package stringifies with sensible defaults; _server goes last naturally because
  // it's last in the object. Add a visual separator comment to mark the server block.
  const yaml = stringifyYaml(metadata, { lineWidth: 0 });
  return yaml.replace(/^_server:/m, "# ---- server-owned; do not edit ----\n_server:");
}

// ---------- team metadata cache ----------

export interface TeamMetadata {
  team_id: string;
  team_key: string;
  fetched_at: string;
  states: { id: string; name: string; type: string }[];
  labels: { id: string; name: string }[];
  members: { id: string; name: string; email: string }[];
  projects: { id: string; name: string; state: string }[];
}

export async function readTeamMetadata(
  repoHash: string,
  teamKey: string,
): Promise<TeamMetadata | null> {
  const path = teamCacheFile(repoHash, teamKey);
  if (!existsSync(path)) return null;
  const text = await Bun.file(path).text();
  return parseYaml(text) as TeamMetadata;
}

export async function writeTeamMetadata(
  repoHash: string,
  teamKey: string,
  metadata: TeamMetadata,
): Promise<void> {
  ensureCacheDirectoryForWrite(dirname(teamCacheFile(repoHash, teamKey)));
  await writeAtomic(teamCacheFile(repoHash, teamKey), stringifyYaml(metadata));
}

export async function invalidateTeamMetadata(repoHash: string, teamKey?: string): Promise<void> {
  if (teamKey !== undefined) {
    await rm(teamCacheFile(repoHash, teamKey), { force: true });
    return;
  }

  const dir = confineCachePath(repoCacheDir(repoHash), "_team");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".yaml"))
      .map((entry) => rm(confineCachePath(dir, entry), { force: true })),
  );
}

function ensureCacheDirectoryForWrite(dir: string): void {
  ensureStateDirectoryForWrite(dir, { label: "cache" });
}

export function isTeamMetadataStale(metadata: TeamMetadata, ttlSeconds = 3600): boolean {
  const fetched = Date.parse(metadata.fetched_at);
  if (Number.isNaN(fetched)) return true;
  return Date.now() - fetched > ttlSeconds * 1000;
}

// ---------- garbage collection ----------

export type GcReason = "age" | "size" | "explicit";

export interface GcCandidate {
  hash: string;
  lastModified: string;
  sizeMb: number;
  reason: GcReason;
}

export interface GcOptions {
  /** Anything where newest file is older than N days qualifies. Default 30. */
  maxAgeDays?: number;
  /** Trim oldest hashes until total cache size is below this limit. Default 500. */
  maxSizeMb?: number;
  /** Single explicit hash to delete. Bypasses age/size selection. */
  hash?: string;
  /** Report candidates but do not delete. Default true. */
  dryRun?: boolean;
  /** Never evict the cwd's repo hash. Default true. */
  preserveCwdRepo?: boolean;
}

export interface GcResult {
  candidates: GcCandidate[];
  removed: string[];
  totalSizeBeforeMb: number;
  totalSizeAfterMb: number;
}

interface HashEntry {
  hash: string;
  newestMtimeMs: number;
  totalBytes: number;
}

/** Reserved subdir under CACHE_ROOT that holds workspace-wide team metadata. */
const GLOBAL_DIR = "_global";
const REPO_HASH_PATTERN = /^[a-f0-9]{12}$/;

/** Recursively sum file sizes and track the newest mtime in a directory. */
async function scanDir(dir: string): Promise<{ totalBytes: number; newestMtimeMs: number }> {
  let totalBytes = 0;
  let newestMtimeMs = 0;
  let entries: Dirent[];
  try {
    // readdir overloads pick a less precise type when not type-narrowed; cast.
    entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
  } catch {
    // Directory disappeared mid-scan or unreadable; treat as empty.
    return { totalBytes, newestMtimeMs };
  }
  for (const ent of entries) {
    const child = join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await scanDir(child);
      totalBytes += sub.totalBytes;
      if (sub.newestMtimeMs > newestMtimeMs) newestMtimeMs = sub.newestMtimeMs;
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      try {
        const st = await stat(child);
        totalBytes += st.size;
        const mt = st.mtimeMs;
        if (mt > newestMtimeMs) newestMtimeMs = mt;
      } catch {
        // race: file removed between readdir and stat — ignore.
      }
    }
  }
  return { totalBytes, newestMtimeMs };
}

function bytesToMb(bytes: number): number {
  // Round to 2 decimal places for stable, human-readable output.
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/**
 * Identify the cwd's repo-hash if it lives in a git repo. Returns null when
 * the cwd has no `.git` ancestor — matches the `_global` fallback in
 * `resolveConfig`. We intentionally do NOT preserve `_global` here; that
 * dir is treated as workspace metadata (not a repo cache) and never
 * appears in candidate selection regardless of the preserve flag.
 */
function detectCwdRepoHash(): string | null {
  const root = findGitRoot(process.cwd());
  if (!root) return null;
  return hashRepoRoot(root);
}

/**
 * Garbage-collect stale per-repo cache subdirs under `~/.lebop/cache/`.
 *
 * Selection modes:
 *   - `hash` set → only that one is a candidate (reason: "explicit").
 *   - else `maxAgeDays` and/or `maxSizeMb` → union of age + size selection.
 *
 * `preserveCwdRepo` (default true) skips the cwd's repo hash even if it
 * qualifies — protects an active workspace from a misfired gc.
 *
 * `_global` (workspace-wide team metadata) is never a candidate.
 */
export async function gcCache(opts: GcOptions = {}): Promise<GcResult> {
  const { maxAgeDays, maxSizeMb, hash: explicitHash, dryRun = true, preserveCwdRepo = true } = opts;

  if (explicitHash && !REPO_HASH_PATTERN.test(explicitHash)) {
    throw new ValidationError(
      `invalid cache gc hash: ${explicitHash}`,
      "pass a 12-character lowercase repo hash from `lebop cache gc --json` candidates",
    );
  }

  // Apply defaults only when neither selector was provided AND no explicit
  // hash was given. This lets callers pass `{ maxAgeDays: 7 }` without
  // implicitly tripping the 500-MB size cap.
  const useDefaults = !explicitHash && maxAgeDays === undefined && maxSizeMb === undefined;
  const effectiveMaxAgeDays = useDefaults ? 30 : maxAgeDays;
  const effectiveMaxSizeMb = useDefaults ? 500 : maxSizeMb;

  if (!(await cacheRootExistsForGc())) {
    return { candidates: [], removed: [], totalSizeBeforeMb: 0, totalSizeAfterMb: 0 };
  }

  // Enumerate per-repo subdirs (skip _global and any stray files).
  const rootEntries = await readdir(CACHE_ROOT, { withFileTypes: true });
  const hashDirs = rootEntries
    .filter((e) => e.isDirectory() && e.name !== GLOBAL_DIR && REPO_HASH_PATTERN.test(e.name))
    .map((e) => e.name);

  const entries: HashEntry[] = [];
  for (const h of hashDirs) {
    const { totalBytes, newestMtimeMs } = await scanDir(join(CACHE_ROOT, h));
    entries.push({ hash: h, totalBytes, newestMtimeMs });
  }

  const totalSizeBeforeBytes = entries.reduce((acc, e) => acc + e.totalBytes, 0);

  const cwdHash = preserveCwdRepo ? detectCwdRepoHash() : null;
  const preservedSet = new Set<string>();
  if (cwdHash) preservedSet.add(cwdHash);

  // Candidate selection.
  const candidatesByHash = new Map<string, GcCandidate>();

  const toCandidate = (e: HashEntry, reason: GcReason): GcCandidate => ({
    hash: e.hash,
    lastModified:
      e.newestMtimeMs > 0 ? new Date(e.newestMtimeMs).toISOString() : new Date(0).toISOString(),
    sizeMb: bytesToMb(e.totalBytes),
    reason,
  });

  if (explicitHash) {
    const match = entries.find((e) => e.hash === explicitHash);
    if (match && !preservedSet.has(match.hash)) {
      candidatesByHash.set(match.hash, toCandidate(match, "explicit"));
    }
  } else {
    // Age-based: anything older than the threshold qualifies.
    if (effectiveMaxAgeDays !== undefined) {
      const cutoff = Date.now() - effectiveMaxAgeDays * 86_400_000;
      for (const e of entries) {
        if (preservedSet.has(e.hash)) continue;
        // Treat zero-byte / unscannable dirs as ancient (newestMtimeMs=0).
        if (e.newestMtimeMs < cutoff) {
          candidatesByHash.set(e.hash, toCandidate(e, "age"));
        }
      }
    }

    // Size-based: oldest first until projected total drops below limit.
    if (effectiveMaxSizeMb !== undefined) {
      const limitBytes = effectiveMaxSizeMb * 1024 * 1024;
      if (totalSizeBeforeBytes > limitBytes) {
        // Compute remaining size assuming already-selected age candidates
        // will be evicted. Then trim more from oldest non-preserved until
        // under the limit.
        const alreadySelected = new Set(candidatesByHash.keys());
        let projected = totalSizeBeforeBytes;
        for (const h of alreadySelected) {
          const e = entries.find((x) => x.hash === h);
          if (e) projected -= e.totalBytes;
        }
        const remaining = entries
          .filter((e) => !alreadySelected.has(e.hash) && !preservedSet.has(e.hash))
          .sort((a, b) => a.newestMtimeMs - b.newestMtimeMs);
        for (const e of remaining) {
          if (projected <= limitBytes) break;
          // Don't override an age-selected entry's reason; only add new ones.
          if (!candidatesByHash.has(e.hash)) {
            candidatesByHash.set(e.hash, toCandidate(e, "size"));
          }
          projected -= e.totalBytes;
        }
      }
    }
  }

  // Stable order: newest-first feels wrong for a cleanup report — show
  // oldest first so the most-stale entries lead. Ties by hash for
  // determinism.
  const candidates = Array.from(candidatesByHash.values()).sort((a, b) => {
    const t = Date.parse(a.lastModified) - Date.parse(b.lastModified);
    if (t !== 0) return t;
    return a.hash.localeCompare(b.hash);
  });

  if (dryRun) {
    return {
      candidates,
      removed: [],
      totalSizeBeforeMb: bytesToMb(totalSizeBeforeBytes),
      totalSizeAfterMb: bytesToMb(totalSizeBeforeBytes),
    };
  }

  const removed: string[] = [];
  let removedBytes = 0;
  for (const c of candidates) {
    const dir = join(CACHE_ROOT, c.hash);
    try {
      await assertGcRemovalTarget(dir, c.hash);
      await rm(dir, { recursive: true, force: true });
      removed.push(c.hash);
      const entry = entries.find((e) => e.hash === c.hash);
      if (entry) removedBytes += entry.totalBytes;
    } catch {
      // Best-effort: skip directories we couldn't remove (permissions, race).
      // The candidate still appears in the report, but isn't in `removed`.
    }
  }

  return {
    candidates,
    removed,
    totalSizeBeforeMb: bytesToMb(totalSizeBeforeBytes),
    totalSizeAfterMb: bytesToMb(totalSizeBeforeBytes - removedBytes),
  };
}

async function cacheRootExistsForGc(): Promise<boolean> {
  assertNoSymlinkedExistingAncestorsSync(CACHE_ROOT, {
    label: "cache root",
    hint: "replace the symlinked state directory or choose a new LEBOP_HOME",
  });
  const rootStat = await lstat(CACHE_ROOT).catch((err) => {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  });
  if (!rootStat) return false;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ValidationError(
      `refusing to run cache gc through unsafe cache root: ${CACHE_ROOT}`,
      "replace the cache root with a normal directory, or choose a new LEBOP_HOME",
    );
  }
  return true;
}

async function assertGcRemovalTarget(dir: string, hash: string): Promise<void> {
  if (!REPO_HASH_PATTERN.test(hash)) {
    throw new ValidationError(
      `invalid cache gc candidate hash: ${hash}`,
      "cache gc only removes canonical per-repo cache directories",
    );
  }
  const targetStat = await lstat(dir).catch(() => null);
  if (!targetStat) return;
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new ValidationError(
      `refusing to remove unsafe cache gc candidate: ${dir}`,
      "cache gc only removes normal per-repo cache directories under lebop's cache root",
    );
  }
}
