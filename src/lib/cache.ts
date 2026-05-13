import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { findGitRoot, hashRepoRoot } from "./config.ts";
import { CACHE_ROOT } from "./paths.ts";

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
  content_hash: string;
  updated_at: string;
}

export interface ProjectMetadata {
  name: string;
  description: string;
  state: string;
  _server: ProjectServerSnapshot;
}

// ---------- paths ----------

export function repoCacheDir(repoHash: string): string {
  return join(CACHE_ROOT, repoHash);
}

export function issueDir(repoHash: string, identifier: string): string {
  return join(repoCacheDir(repoHash), "issues", identifier);
}

export function projectDir(repoHash: string, projectId: string): string {
  return join(repoCacheDir(repoHash), "projects", projectId);
}

export function teamCacheFile(repoHash: string, teamKey: string): string {
  return join(repoCacheDir(repoHash), "_team", `${teamKey}.yaml`);
}

// ---------- atomic write ----------

export async function writeAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
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

export async function writeIssue(
  repoHash: string,
  metadata: IssueMetadata,
  description: string,
): Promise<void> {
  const dir = issueDir(repoHash, metadata.identifier);
  mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, "metadata.yaml");
  const descPath = join(dir, "description.md");
  await writeAtomic(descPath, description);
  await writeAtomic(metaPath, serializeIssueMetadata(metadata));
}

export async function readIssue(
  repoHash: string,
  identifier: string,
): Promise<{ metadata: IssueMetadata; description: string } | null> {
  const dir = issueDir(repoHash, identifier);
  const metaPath = join(dir, "metadata.yaml");
  const descPath = join(dir, "description.md");
  if (!existsSync(metaPath) || !existsSync(descPath)) return null;
  const metaText = await Bun.file(metaPath).text();
  const metadata = parseYaml(metaText) as IssueMetadata;
  const description = await Bun.file(descPath).text();
  return { metadata, description };
}

export async function listCachedIssues(repoHash: string): Promise<string[]> {
  const dir = join(repoCacheDir(repoHash), "issues");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export async function listCachedProjectIds(repoHash: string): Promise<string[]> {
  const dir = join(repoCacheDir(repoHash), "projects");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

// ---------- project read/write ----------

export async function writeProject(
  repoHash: string,
  metadata: ProjectMetadata,
  content: string,
): Promise<void> {
  const dir = projectDir(repoHash, metadata._server.id);
  mkdirSync(dir, { recursive: true });
  await writeAtomic(join(dir, "content.md"), content);
  await writeAtomic(join(dir, "metadata.yaml"), stringifyYaml(metadata));
}

export async function readProject(
  repoHash: string,
  projectId: string,
): Promise<{ metadata: ProjectMetadata; content: string } | null> {
  const dir = projectDir(repoHash, projectId);
  const metaPath = join(dir, "metadata.yaml");
  const contentPath = join(dir, "content.md");
  if (!existsSync(metaPath) || !existsSync(contentPath)) return null;
  const metaText = await Bun.file(metaPath).text();
  const metadata = parseYaml(metaText) as ProjectMetadata;
  const content = await Bun.file(contentPath).text();
  return { metadata, content };
}

// ---------- comments ----------

export async function writeComment(
  repoHash: string,
  issueId: string,
  comment: CachedComment,
): Promise<void> {
  const dir = join(issueDir(repoHash, issueId), "comments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${comment.frontmatter.id}.md`);
  const text = `---\n${stringifyYaml(comment.frontmatter)}---\n\n${comment.body}\n`;
  await writeAtomic(file, text);
}

export async function clearComments(repoHash: string, issueId: string): Promise<void> {
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
  await writeAtomic(teamCacheFile(repoHash, teamKey), stringifyYaml(metadata));
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

  // Apply defaults only when neither selector was provided AND no explicit
  // hash was given. This lets callers pass `{ maxAgeDays: 7 }` without
  // implicitly tripping the 500-MB size cap.
  const useDefaults = !explicitHash && maxAgeDays === undefined && maxSizeMb === undefined;
  const effectiveMaxAgeDays = useDefaults ? 30 : maxAgeDays;
  const effectiveMaxSizeMb = useDefaults ? 500 : maxSizeMb;

  if (!existsSync(CACHE_ROOT)) {
    return { candidates: [], removed: [], totalSizeBeforeMb: 0, totalSizeAfterMb: 0 };
  }

  // Enumerate per-repo subdirs (skip _global and any stray files).
  const rootEntries = await readdir(CACHE_ROOT, { withFileTypes: true });
  const hashDirs = rootEntries
    .filter((e) => e.isDirectory() && e.name !== GLOBAL_DIR)
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
