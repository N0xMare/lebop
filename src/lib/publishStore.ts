import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { sha256, writeAtomic } from "./cache.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { PUBLISH_REVIEW_ROOT } from "./paths.ts";
import { parsePlan } from "./planParse.ts";
import { ensureStateDirectoryForWrite } from "./stateSafety.ts";

export interface PublishReviewRecord {
  review_id: string;
  source:
    | { kind: "plan"; dir: string }
    | {
        kind: "cache";
        repo_hash: string;
        repo_root?: string;
        identifiers: string[];
        project_ids: string[];
      };
  requested_source?: {
    kind: "cache";
    repo_hash: string;
    repo_root?: string;
    identifiers: string[];
    project_ids: string[];
    all_modified: boolean;
  };
  team: string;
  strict: boolean;
  content_hash: string;
  created_at: string;
  workspace?: {
    id?: string;
    url_key?: string;
    name?: string;
  };
  remote_snapshot?: {
    project?: { id: string; updated_at: string };
    issues?: Array<{ identifier: string; id?: string; updated_at: string }>;
    projects?: Array<{ id: string; updated_at: string }>;
    missing?: Array<{ kind: "issue" | "project"; target: string }>;
  };
  review?: {
    ready: boolean;
    blockers: string[];
    status?: "ready" | "blocked" | "applying" | "applied" | "failed";
    attempt_started_at?: string;
    completed_at?: string;
    error?: string;
  };
}

const REVIEW_ID_PATTERN =
  /^pub_\d{14}_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PUBLISH_REVIEW_LOCK_STALE_MS = 5 * 60 * 1000;
const PUBLISH_REVIEW_LOCK_TIMEOUT_MS = 30 * 1000;
const PUBLISH_REVIEW_LOCK_RETRY_MS = 10;
let staleLockReclaimCounter = 0;

export async function hashPlanDir(dir: string): Promise<string> {
  const abs = resolve(dir);
  const plan = await parsePlan(abs);
  const files = [plan.project.path, ...plan.issues.map((issue) => issue.path)].sort((a, b) =>
    relative(abs, a).localeCompare(relative(abs, b)),
  );
  const chunks: string[] = [];
  for (const file of files) {
    chunks.push(`${relative(abs, file)}\0${await readFile(file, "utf8")}`);
  }
  return sha256(chunks.join("\0"));
}

export async function createPublishReviewRecord(input: {
  dir: string;
  team: string;
  strict?: boolean;
  workspace?: PublishReviewRecord["workspace"];
  remoteSnapshot?: PublishReviewRecord["remote_snapshot"];
  review?: PublishReviewRecord["review"];
}): Promise<PublishReviewRecord> {
  const contentHash = await hashPlanDir(input.dir);
  const createdAt = new Date().toISOString();
  const reviewId = `pub_${createdAt.replace(/[-:TZ.]/g, "").slice(0, 14)}_${randomUUID()}`;
  const record: PublishReviewRecord = {
    review_id: reviewId,
    source: { kind: "plan", dir: resolve(input.dir) },
    team: input.team,
    strict: input.strict === true,
    content_hash: contentHash,
    created_at: createdAt,
    workspace: input.workspace,
    remote_snapshot: input.remoteSnapshot,
    review: input.review,
  };
  await writePublishReviewRecord(record);
  return record;
}

export async function createCachePublishReviewRecord(input: {
  source: Extract<PublishReviewRecord["source"], { kind: "cache" }>;
  requestedSource?: PublishReviewRecord["requested_source"];
  team: string;
  strict?: boolean;
  contentHash: string;
  workspace?: PublishReviewRecord["workspace"];
  remoteSnapshot?: PublishReviewRecord["remote_snapshot"];
  review?: PublishReviewRecord["review"];
}): Promise<PublishReviewRecord> {
  const createdAt = new Date().toISOString();
  const reviewId = `pub_${createdAt.replace(/[-:TZ.]/g, "").slice(0, 14)}_${randomUUID()}`;
  const record: PublishReviewRecord = {
    review_id: reviewId,
    source: input.source,
    requested_source: input.requestedSource,
    team: input.team,
    strict: input.strict === true,
    content_hash: input.contentHash,
    created_at: createdAt,
    workspace: input.workspace,
    remote_snapshot: input.remoteSnapshot,
    review: input.review,
  };
  await writePublishReviewRecord(record);
  return record;
}

export async function writePublishReviewRecord(record: PublishReviewRecord): Promise<void> {
  validateReviewId(record.review_id);
  assertPublishReviewRecord(record);
  ensurePublishReviewRootForWrite();
  await writeAtomic(reviewPath(record.review_id), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readPublishReviewRecord(reviewId: string): Promise<PublishReviewRecord> {
  validateReviewId(reviewId);
  const file = reviewPath(reviewId);
  if (!existsSync(file)) {
    throw new NotFoundError(
      `publish review not found: ${reviewId}`,
      "run `lebop publish review --plan <dir>` / `lebop publish review --cache`, or call review_linear_changes first",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new ValidationError(
      `publish review record is invalid JSON: ${reviewId}`,
      (err as Error).message,
    );
  }
  const record = assertPublishReviewRecord(parsed);
  if (record.review_id !== reviewId) {
    throw new ValidationError(
      `publish review record id mismatch: ${reviewId}`,
      "delete the mismatched local review record and run review_linear_changes again",
    );
  }
  return record;
}

export async function markPublishReviewApplying(reviewId: string): Promise<PublishReviewRecord> {
  return withPublishReviewLock(reviewId, async () => {
    const record = await readPublishReviewRecord(reviewId);
    assertReviewCanStartApply(record);
    record.review = {
      ...(record.review ?? { ready: true, blockers: [] }),
      status: "applying",
      attempt_started_at: new Date().toISOString(),
    };
    await writePublishReviewRecord(record);
    return record;
  });
}

export async function markPublishReviewCompleted(
  reviewId: string,
  status: "applied" | "failed",
  error?: string,
): Promise<void> {
  await withPublishReviewLock(reviewId, async () => {
    const record = await readPublishReviewRecord(reviewId);
    record.review = {
      ...(record.review ?? { ready: status === "applied", blockers: [] }),
      status,
      completed_at: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
    await writePublishReviewRecord(record);
  });
}

export async function markPublishReviewBlocked(
  reviewId: string,
  reason: string,
  blockers: string[] = [],
  options: { allowAlreadyBlocked?: boolean } = {},
): Promise<void> {
  await withPublishReviewLock(reviewId, async () => {
    const record = await readPublishReviewRecord(reviewId);
    assertReviewCanBlockApply(record, options);
    const startedAt = record.review?.attempt_started_at ?? new Date().toISOString();
    const existingBlockers = record.review?.blockers ?? [];
    const nextBlockers = [...new Set([...existingBlockers, ...blockers, reason])];
    record.review = {
      ...(record.review ?? { ready: false, blockers: [] }),
      ready: false,
      blockers: nextBlockers,
      status: "blocked",
      attempt_started_at: startedAt,
      completed_at: new Date().toISOString(),
      error: reason,
    };
    await writePublishReviewRecord(record);
  });
}

export function reviewPath(reviewId: string): string {
  validateReviewId(reviewId);
  const root = resolve(PUBLISH_REVIEW_ROOT);
  const file = resolve(root, `${reviewId}.json`);
  const rel = relative(root, file);
  if (rel.startsWith("..") || rel === ".." || rel.includes("..")) {
    throw new ValidationError(
      `invalid publish review id: ${reviewId}`,
      "use the exact review_id returned by review_linear_changes",
    );
  }
  return file;
}

async function withPublishReviewLock<T>(reviewId: string, fn: () => Promise<T>): Promise<T> {
  validateReviewId(reviewId);
  ensurePublishReviewRootForWrite();
  const lockPath = `${reviewPath(reviewId)}.lock`;
  const deadline = Date.now() + PUBLISH_REVIEW_LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          review_id: reviewId,
          acquired_at: new Date().toISOString(),
        }),
      );
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") throw err;
      const stat = await lstat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > PUBLISH_REVIEW_LOCK_STALE_MS) {
        await reclaimStalePublishReviewLock(lockPath, reviewId);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ValidationError(
          `publish review ${reviewId} is locked by another apply process`,
          "wait for the in-flight apply to finish, then inspect the review status before retrying",
        );
      }
      await sleep(PUBLISH_REVIEW_LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function reclaimStalePublishReviewLock(lockPath: string, reviewId: string): Promise<void> {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimHandle: Awaited<ReturnType<typeof open>> | null = null;
  while (!reclaimHandle) {
    try {
      reclaimHandle = await open(reclaimPath, "wx", 0o600);
      await reclaimHandle.writeFile(
        JSON.stringify({
          pid: process.pid,
          review_id: reviewId,
          reclaiming_at: new Date().toISOString(),
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") {
        if (await removeStalePublishReviewReclaimLock(reclaimPath, reviewId)) continue;
        await sleep(PUBLISH_REVIEW_LOCK_RETRY_MS);
        return;
      }
      throw err;
    }
  }

  try {
    const stat = await lstat(lockPath).catch(() => null);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ValidationError(
        `publish review ${reviewId} has an unsafe lock file`,
        "remove the invalid .lock path after verifying no apply process is running",
      );
    }
    if (Date.now() - stat.mtimeMs <= PUBLISH_REVIEW_LOCK_STALE_MS) return;

    const reclaimedPath = `${lockPath}.stale-${process.pid}-${Date.now()}-${staleLockReclaimCounter++}`;
    try {
      await rename(lockPath, reclaimedPath);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return;
      throw err;
    }
    await rm(reclaimedPath, { force: true });
  } finally {
    await reclaimHandle.close().catch(() => {});
    await rm(reclaimPath, { force: true }).catch(() => {});
  }
}

async function removeStalePublishReviewReclaimLock(
  reclaimPath: string,
  reviewId: string,
): Promise<boolean> {
  const stat = await lstat(reclaimPath).catch(() => null);
  if (!stat) return true;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ValidationError(
      `publish review ${reviewId} has an unsafe reclaim lock file`,
      "remove the invalid .lock.reclaim path after verifying no apply process is running",
    );
  }
  if (Date.now() - stat.mtimeMs <= PUBLISH_REVIEW_LOCK_STALE_MS) return false;
  await rm(reclaimPath, { force: true });
  return true;
}

function ensurePublishReviewRootForWrite(): void {
  ensureStateDirectoryForWrite(PUBLISH_REVIEW_ROOT, { label: "publish review store" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function validateReviewId(reviewId: string): void {
  if (!REVIEW_ID_PATTERN.test(reviewId)) {
    throw new ValidationError(
      `invalid publish review id: ${reviewId}`,
      "use the exact review_id returned by review_linear_changes",
    );
  }
}

function assertPublishReviewRecord(value: unknown): PublishReviewRecord {
  if (!isRecord(value)) {
    throw new ValidationError(
      "publish review record is invalid",
      "delete the local review record and run review_linear_changes again",
    );
  }
  if (typeof value.review_id !== "string") {
    throwInvalidRecord("missing string review_id");
  }
  validateReviewId(value.review_id);
  validateSource(value.source);
  if (value.requested_source !== undefined) validateRequestedSource(value.requested_source);
  if (typeof value.team !== "string" || value.team.trim() === "") {
    throwInvalidRecord("team must be a non-empty string");
  }
  if (typeof value.strict !== "boolean") {
    throwInvalidRecord("strict must be a boolean");
  }
  if (typeof value.content_hash !== "string" || !HEX_SHA256_PATTERN.test(value.content_hash)) {
    throwInvalidRecord("content_hash must be a sha256 hex digest");
  }
  if (typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
    throwInvalidRecord("created_at must be an ISO timestamp");
  }
  if (value.workspace !== undefined) validateWorkspaceSnapshot(value.workspace);
  if (value.remote_snapshot !== undefined) validateRemoteSnapshot(value.remote_snapshot);
  if (value.review !== undefined) validateReviewState(value.review);
  return value as unknown as PublishReviewRecord;
}

function validateRequestedSource(value: unknown): void {
  if (!isRecord(value)) throwInvalidRecord("requested_source must be an object");
  if (value.kind !== "cache") throwInvalidRecord("requested_source kind must be 'cache'");
  validateCacheSourceShape(value, "requested_source");
  if (typeof value.all_modified !== "boolean") {
    throwInvalidRecord("requested_source all_modified must be a boolean");
  }
}

function validateSource(value: unknown): void {
  if (!isRecord(value)) throwInvalidRecord("source must be an object");
  if (value.kind === "plan") {
    if (typeof value.dir !== "string") {
      throwInvalidRecord("plan source must include dir");
    }
    return;
  }
  if (value.kind === "cache") {
    validateCacheSourceShape(value, "cache source");
    return;
  }
  throwInvalidRecord("source kind must be 'plan' or 'cache'");
}

function validateCacheSourceShape(value: Record<string, unknown>, label: string): void {
  if (typeof value.repo_hash !== "string" || value.repo_hash.trim() === "") {
    throwInvalidRecord(`${label} must include repo_hash`);
  }
  if (value.repo_root !== undefined && typeof value.repo_root !== "string") {
    throwInvalidRecord(`${label} repo_root must be a string`);
  }
  if (!Array.isArray(value.identifiers) || !value.identifiers.every((v) => typeof v === "string")) {
    throwInvalidRecord(`${label} identifiers must be a string array`);
  }
  if (!Array.isArray(value.project_ids) || !value.project_ids.every((v) => typeof v === "string")) {
    throwInvalidRecord(`${label} project_ids must be a string array`);
  }
}

function validateWorkspaceSnapshot(value: unknown): void {
  if (!isRecord(value)) throwInvalidRecord("workspace must be an object");
  for (const key of ["id", "url_key", "name"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throwInvalidRecord(`workspace.${key} must be a string`);
    }
  }
}

function validateRemoteSnapshot(value: unknown): void {
  if (!isRecord(value)) throwInvalidRecord("remote_snapshot must be an object");
  if (value.project !== undefined) {
    if (!isRecord(value.project)) throwInvalidRecord("remote_snapshot.project must be an object");
    if (typeof value.project.id !== "string" || typeof value.project.updated_at !== "string") {
      throwInvalidRecord("remote_snapshot.project must include id and updated_at strings");
    }
  }
  if (value.issues !== undefined) {
    if (!Array.isArray(value.issues)) {
      throwInvalidRecord("remote_snapshot.issues must be an array");
    }
    for (const issue of value.issues) {
      if (!isRecord(issue)) throwInvalidRecord("remote_snapshot.issues entries must be objects");
      if (typeof issue.identifier !== "string" || typeof issue.updated_at !== "string") {
        throwInvalidRecord("remote_snapshot.issues entries must include identifier and updated_at");
      }
      if (issue.id !== undefined && typeof issue.id !== "string") {
        throwInvalidRecord("remote_snapshot.issues id must be a string");
      }
    }
  }
  if (value.projects !== undefined) {
    if (!Array.isArray(value.projects)) {
      throwInvalidRecord("remote_snapshot.projects must be an array");
    }
    for (const project of value.projects) {
      if (!isRecord(project))
        throwInvalidRecord("remote_snapshot.projects entries must be objects");
      if (typeof project.id !== "string" || typeof project.updated_at !== "string") {
        throwInvalidRecord("remote_snapshot.projects entries must include id and updated_at");
      }
    }
  }
  if (value.missing !== undefined) {
    if (!Array.isArray(value.missing)) {
      throwInvalidRecord("remote_snapshot.missing must be an array");
    }
    for (const row of value.missing) {
      if (!isRecord(row)) throwInvalidRecord("remote_snapshot.missing entries must be objects");
      if (row.kind !== "issue" && row.kind !== "project") {
        throwInvalidRecord("remote_snapshot.missing kind must be issue or project");
      }
      if (typeof row.target !== "string" || row.target.trim() === "") {
        throwInvalidRecord("remote_snapshot.missing target must be a non-empty string");
      }
    }
  }
}

function validateReviewState(value: unknown): void {
  if (!isRecord(value)) throwInvalidRecord("review must be an object");
  if (typeof value.ready !== "boolean") {
    throwInvalidRecord("review.ready must be a boolean");
  }
  if (!Array.isArray(value.blockers) || !value.blockers.every((v) => typeof v === "string")) {
    throwInvalidRecord("review.blockers must be a string array");
  }
  if (
    value.status !== undefined &&
    !["ready", "blocked", "applying", "applied", "failed"].includes(String(value.status))
  ) {
    throwInvalidRecord("review.status must be ready, blocked, applying, applied, or failed");
  }
  for (const field of ["attempt_started_at", "completed_at", "error"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throwInvalidRecord(`review.${field} must be a string`);
    }
  }
}

function assertReviewCanStartApply(record: PublishReviewRecord): void {
  const status = record.review?.status;
  if (status === undefined || status === "ready") return;
  throw new ValidationError(
    `publish review ${record.review_id} is already ${status}`,
    "publish reviews are single-use; run review_linear_changes again and publish the new review_id",
  );
}

function assertReviewCanBlockApply(
  record: PublishReviewRecord,
  options: { allowAlreadyBlocked?: boolean },
): void {
  const status = record.review?.status;
  if (status === undefined || status === "ready") return;
  if (status === "blocked" && options.allowAlreadyBlocked === true) return;
  throw new ValidationError(
    `publish review ${record.review_id} is already ${status}`,
    "publish reviews are single-use; run review_linear_changes again and publish the new review_id",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function throwInvalidRecord(reason: string): never {
  throw new ValidationError(
    `publish review record is invalid: ${reason}`,
    "delete the local review record and run review_linear_changes again",
  );
}
