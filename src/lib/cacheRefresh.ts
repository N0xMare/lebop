import { buildIssueMetadata, buildProjectMetadata } from "./build.ts";
import { readIssue, readProject, writeIssueIfCurrent, writeProjectIfCurrent } from "./cache.ts";
import { findGitRoot, hashRepoRoot } from "./config.ts";
import { diffIssueMetadata, diffProjectMetadata } from "./diff.ts";
import { getIssue } from "./issues.ts";
import type { FullProject } from "./projects.ts";
import type { FetchedIssue, FetchedProject } from "./pullQuery.ts";

export interface IssueCacheRefreshResult {
  checked: boolean;
  present: boolean;
  refreshed: boolean;
  repo_hash?: string;
  repo_root?: string;
  identifier?: string;
  updated_at?: string;
  dirty?: { fields: string[] };
  error?: { code: string; message: string; hint?: string };
}

export interface ProjectCacheRefreshResult {
  checked: boolean;
  present: boolean;
  refreshed: boolean;
  repo_hash?: string;
  repo_root?: string;
  project_id?: string;
  updated_at?: string;
  dirty?: { fields: string[] };
  error?: { code: string; message: string; hint?: string };
}

export interface CacheRefreshContext {
  repoHash?: string;
  repoRoot?: string | null;
  freshIssue?: FetchedIssue;
}

export async function refreshCachedIssueByIdentifier(
  identifier: string,
  context: CacheRefreshContext = {},
): Promise<IssueCacheRefreshResult> {
  const repoRoot = context.repoRoot ?? findGitRoot(process.cwd());
  const repoHash = context.repoHash ?? (repoRoot ? hashRepoRoot(repoRoot) : "_global");
  const idLooksUuid = /^[0-9a-f-]{36}$/i.test(identifier);
  let cacheKey = idLooksUuid ? identifier : identifier.toUpperCase();

  try {
    let freshForWrite: Awaited<ReturnType<typeof getIssue>> | null = context.freshIssue ?? null;
    if (freshForWrite) {
      cacheKey = freshForWrite.identifier;
    } else if (idLooksUuid) {
      freshForWrite = await getIssue(identifier);
      if (!freshForWrite) {
        return {
          checked: true,
          present: false,
          refreshed: false,
          repo_hash: repoHash,
          ...(repoRoot ? { repo_root: repoRoot } : {}),
          identifier,
          error: {
            code: "not_found",
            message: `issue ${identifier} was updated but could not be refetched`,
          },
        };
      }
      cacheKey = freshForWrite.identifier;
    }

    const cached = await readIssue(repoHash, cacheKey);
    if (!cached) {
      return {
        checked: true,
        present: false,
        refreshed: false,
        repo_hash: repoHash,
        ...(repoRoot ? { repo_root: repoRoot } : {}),
        identifier: cacheKey,
      };
    }

    const dirtyFields = diffIssueMetadata(cached.metadata, cached.description).map((c) => c.field);
    if (dirtyFields.length > 0) {
      return issueDirtyResult(repoHash, repoRoot, cacheKey, dirtyFields);
    }

    const fresh = freshForWrite ?? (await getIssue(cacheKey));
    if (!fresh) {
      return {
        checked: true,
        present: true,
        refreshed: false,
        repo_hash: repoHash,
        ...(repoRoot ? { repo_root: repoRoot } : {}),
        identifier: cacheKey,
        error: {
          code: "not_found",
          message: `issue ${cacheKey} was updated but could not be refetched`,
        },
      };
    }

    const rebuilt = buildIssueMetadata(fresh);
    const writeResult = await writeIssueIfCurrent(
      repoHash,
      cacheKey,
      (current) => diffIssueMetadata(current.metadata, current.description).length === 0,
      rebuilt.metadata,
      rebuilt.description,
    );
    if (writeResult.status === "missing") {
      return {
        checked: true,
        present: false,
        refreshed: false,
        repo_hash: repoHash,
        ...(repoRoot ? { repo_root: repoRoot } : {}),
        identifier: cacheKey,
      };
    }
    if (writeResult.status === "guard-failed") {
      const fields = diffIssueMetadata(
        writeResult.current.metadata,
        writeResult.current.description,
      ).map((c) => c.field);
      return issueDirtyResult(repoHash, repoRoot, cacheKey, fields);
    }
    return {
      checked: true,
      present: true,
      refreshed: true,
      repo_hash: repoHash,
      ...(repoRoot ? { repo_root: repoRoot } : {}),
      identifier: fresh.identifier,
      updated_at: fresh.updatedAt,
    };
  } catch (err) {
    return {
      checked: true,
      present: true,
      refreshed: false,
      repo_hash: repoHash,
      ...(repoRoot ? { repo_root: repoRoot } : {}),
      identifier: cacheKey,
      error: {
        code: "error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export async function refreshCachedProjectAfterUpdate(
  project: FullProject,
  context: CacheRefreshContext = {},
): Promise<ProjectCacheRefreshResult> {
  const repoRoot = context.repoRoot ?? findGitRoot(process.cwd());
  const repoHash = context.repoHash ?? (repoRoot ? hashRepoRoot(repoRoot) : "_global");

  try {
    const cached = await readProject(repoHash, project.id);
    if (!cached) {
      return {
        checked: true,
        present: false,
        refreshed: false,
        repo_hash: repoHash,
        ...(repoRoot ? { repo_root: repoRoot } : {}),
        project_id: project.id,
      };
    }

    const dirtyFields = diffProjectMetadata(cached.metadata, cached.content).map((c) => c.field);
    if (dirtyFields.length > 0) {
      return projectDirtyResult(repoHash, repoRoot, project.id, dirtyFields);
    }

    const rebuilt = buildProjectMetadata(projectToFetchedProject(project));
    const writeResult = await writeProjectIfCurrent(
      repoHash,
      project.id,
      (current) => diffProjectMetadata(current.metadata, current.content).length === 0,
      rebuilt.metadata,
      rebuilt.content,
    );
    if (writeResult.status === "missing") {
      return {
        checked: true,
        present: false,
        refreshed: false,
        repo_hash: repoHash,
        ...(repoRoot ? { repo_root: repoRoot } : {}),
        project_id: project.id,
      };
    }
    if (writeResult.status === "guard-failed") {
      const fields = diffProjectMetadata(
        writeResult.current.metadata,
        writeResult.current.content,
      ).map((c) => c.field);
      return projectDirtyResult(repoHash, repoRoot, project.id, fields);
    }
    return {
      checked: true,
      present: true,
      refreshed: true,
      repo_hash: repoHash,
      ...(repoRoot ? { repo_root: repoRoot } : {}),
      project_id: project.id,
      updated_at: project.updated_at,
    };
  } catch (err) {
    return {
      checked: true,
      present: true,
      refreshed: false,
      repo_hash: repoHash,
      ...(repoRoot ? { repo_root: repoRoot } : {}),
      project_id: project.id,
      error: {
        code: "error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function issueDirtyResult(
  repoHash: string,
  repoRoot: string | null,
  identifier: string,
  fields: string[],
): IssueCacheRefreshResult {
  return {
    checked: true,
    present: true,
    refreshed: false,
    repo_hash: repoHash,
    ...(repoRoot ? { repo_root: repoRoot } : {}),
    identifier,
    dirty: { fields },
    error: {
      code: "cache_dirty",
      message: `cached issue ${identifier} has unpushed local edits; not refreshing it after the Linear mutation`,
      hint: "run `lebop diff` / `lebop push`, or discard the local cache edits before retrying the mutation",
    },
  };
}

function projectDirtyResult(
  repoHash: string,
  repoRoot: string | null,
  projectId: string,
  fields: string[],
): ProjectCacheRefreshResult {
  return {
    checked: true,
    present: true,
    refreshed: false,
    repo_hash: repoHash,
    ...(repoRoot ? { repo_root: repoRoot } : {}),
    project_id: projectId,
    dirty: { fields },
    error: {
      code: "cache_dirty",
      message: `cached project ${projectId} has unpushed local edits; not refreshing it after the Linear mutation`,
      hint: "run `lebop diff` / `lebop push`, or discard the local cache edits before retrying the mutation",
    },
  };
}

function projectToFetchedProject(project: FullProject): FetchedProject {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? "",
    content: project.content,
    icon: project.icon,
    state: project.state,
    startDate: project.start_date,
    targetDate: project.target_date,
    url: project.url,
    updatedAt: project.updated_at,
    issues: { nodes: [] },
  };
}
