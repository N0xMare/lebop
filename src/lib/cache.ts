import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
  renameSync(tmp, path);
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
