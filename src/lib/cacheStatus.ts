import {
  type IssueMetadata,
  inspectCacheIntegrity,
  listCachedIssues,
  listCachedProjectIds,
  type ProjectMetadata,
  readIssue,
  readProject,
} from "./cache.ts";
import {
  diffIssueMetadata,
  diffProjectMetadata,
  type IssueChange,
  type ProjectChange,
} from "./diff.ts";
import { fetchIssueCasStates, fetchProjectCasStates } from "./pushMutations.ts";

export interface CacheStatusStaleIssue {
  kind: "issue";
  identifier: string;
  server_updated_at: string;
  remote_updated_at: string;
}

export interface CacheStatusStaleProject {
  kind: "project";
  id: string;
  name: string;
  server_updated_at: string;
  remote_updated_at: string;
}

export type CacheStatusStaleEntry = CacheStatusStaleIssue | CacheStatusStaleProject;

export interface CacheStatusRemoteConflictIssue {
  kind: "issue";
  identifier: string;
  local_status: "clean" | "modified";
  reason: "remote-changed" | "remote-missing" | "invalid-timestamp";
  server_updated_at?: string;
  remote_updated_at?: string;
  fields?: string[];
  message?: string;
}

export interface CacheStatusRemoteConflictProject {
  kind: "project";
  id: string;
  name: string;
  local_status: "clean" | "modified";
  reason: "remote-changed" | "remote-missing" | "invalid-timestamp";
  server_updated_at?: string;
  remote_updated_at?: string;
  fields?: string[];
  message?: string;
}

export type CacheStatusRemoteConflictEntry =
  | CacheStatusRemoteConflictIssue
  | CacheStatusRemoteConflictProject;

export interface CacheStatusResult {
  team: string;
  repo_root: string | null;
  repo_hash: string;
  modified: {
    issues: { identifier: string; fields: string[] }[];
    projects: { id: string; name: string; fields: string[] }[];
  };
  stale: CacheStatusStaleEntry[];
  remote_conflicts: CacheStatusRemoteConflictEntry[];
  stale_check: "ok" | "errored" | "skipped";
  stale_check_error?: string;
  clean: {
    issues: string[];
    projects: string[];
  };
  integrity: {
    ok: boolean;
    problems: Awaited<ReturnType<typeof inspectCacheIntegrity>>;
  };
}

interface LoadedIssue {
  id: string;
  metadata: IssueMetadata;
  changes: IssueChange[];
}

interface LoadedProject {
  id: string;
  metadata: ProjectMetadata;
  changes: ProjectChange[];
}

export async function collectCacheStatus(input: {
  team: string;
  repoRoot: string | null;
  repoHash: string;
  checkRemote?: boolean;
}): Promise<CacheStatusResult> {
  const issueIds = await listCachedIssues(input.repoHash);
  const issueResults = await Promise.all(
    issueIds.map(async (id): Promise<LoadedIssue | null> => {
      const loaded = await readIssue(input.repoHash, id);
      if (!loaded) return null;
      return {
        id,
        metadata: loaded.metadata,
        changes: diffIssueMetadata(loaded.metadata, loaded.description),
      };
    }),
  );

  const projectIds = await listCachedProjectIds(input.repoHash);
  const projectResults = await Promise.all(
    projectIds.map(async (id): Promise<LoadedProject | null> => {
      const loaded = await readProject(input.repoHash, id);
      if (!loaded) return null;
      return {
        id,
        metadata: loaded.metadata,
        changes: diffProjectMetadata(loaded.metadata, loaded.content),
      };
    }),
  );

  const modifiedIssues = issueResults.filter(
    (entry): entry is LoadedIssue => entry !== null && entry.changes.length > 0,
  );
  const cleanIssues = issueResults.filter(
    (entry): entry is LoadedIssue => entry !== null && entry.changes.length === 0,
  );
  const modifiedProjects = projectResults.filter(
    (entry): entry is LoadedProject => entry !== null && entry.changes.length > 0,
  );
  const cleanProjects = projectResults.filter(
    (entry): entry is LoadedProject => entry !== null && entry.changes.length === 0,
  );

  const stale: CacheStatusStaleEntry[] = [];
  const remoteConflicts: CacheStatusRemoteConflictEntry[] = [];
  let staleCheck: CacheStatusResult["stale_check"] = "skipped";
  let staleCheckError: string | undefined;
  const loadedIssues = issueResults.filter((entry): entry is LoadedIssue => entry !== null);
  const loadedProjects = projectResults.filter((entry): entry is LoadedProject => entry !== null);
  const shouldCheckRemote =
    input.checkRemote !== false && (loadedIssues.length > 0 || loadedProjects.length > 0);

  if (shouldCheckRemote) {
    try {
      if (loadedIssues.length > 0) {
        const ids = loadedIssues.map((entry) => entry.id);
        const response = await fetchIssueCasStates(ids);
        for (const entry of loadedIssues) {
          const remote = response[entry.id];
          const localStatus = entry.changes.length === 0 ? "clean" : "modified";
          const fields = entry.changes.map((change) => change.field);
          if (!remote) {
            remoteConflicts.push({
              kind: "issue",
              identifier: entry.id,
              local_status: localStatus,
              reason: "remote-missing",
              fields: fields.length > 0 ? fields : undefined,
              server_updated_at: entry.metadata._server.updated_at,
              message: "remote issue is missing or inaccessible",
            });
            continue;
          }
          if (
            !isValidTimestamp(entry.metadata._server.updated_at) ||
            !isValidTimestamp(remote.updatedAt)
          ) {
            remoteConflicts.push({
              kind: "issue",
              identifier: entry.id,
              local_status: localStatus,
              reason: "invalid-timestamp",
              fields: fields.length > 0 ? fields : undefined,
              server_updated_at: entry.metadata._server.updated_at,
              remote_updated_at: remote.updatedAt,
              message: "local or remote updatedAt stale-guard timestamp is invalid",
            });
            continue;
          }
          if (remote.updatedAt !== entry.metadata._server.updated_at) {
            if (localStatus === "modified") {
              remoteConflicts.push({
                kind: "issue",
                identifier: entry.id,
                local_status: localStatus,
                reason: "remote-changed",
                fields,
                server_updated_at: entry.metadata._server.updated_at,
                remote_updated_at: remote.updatedAt,
              });
              continue;
            }
            stale.push({
              kind: "issue",
              identifier: entry.id,
              server_updated_at: entry.metadata._server.updated_at,
              remote_updated_at: remote.updatedAt,
            });
          }
        }
      }
      if (loadedProjects.length > 0) {
        const ids = loadedProjects.map((entry) => entry.id);
        const response = await fetchProjectCasStates(ids);
        for (const entry of loadedProjects) {
          const remote = response[entry.id];
          const localStatus = entry.changes.length === 0 ? "clean" : "modified";
          const fields = entry.changes.map((change) => change.field);
          if (!remote) {
            remoteConflicts.push({
              kind: "project",
              id: entry.id,
              name: entry.metadata.name,
              local_status: localStatus,
              reason: "remote-missing",
              fields: fields.length > 0 ? fields : undefined,
              server_updated_at: entry.metadata._server.updated_at,
              message: "remote project is missing or inaccessible",
            });
            continue;
          }
          if (
            !isValidTimestamp(entry.metadata._server.updated_at) ||
            !isValidTimestamp(remote.updatedAt)
          ) {
            remoteConflicts.push({
              kind: "project",
              id: entry.id,
              name: entry.metadata.name,
              local_status: localStatus,
              reason: "invalid-timestamp",
              fields: fields.length > 0 ? fields : undefined,
              server_updated_at: entry.metadata._server.updated_at,
              remote_updated_at: remote.updatedAt,
              message: "local or remote updatedAt stale-guard timestamp is invalid",
            });
            continue;
          }
          if (remote.updatedAt !== entry.metadata._server.updated_at) {
            if (localStatus === "modified") {
              remoteConflicts.push({
                kind: "project",
                id: entry.id,
                name: entry.metadata.name,
                local_status: localStatus,
                reason: "remote-changed",
                fields,
                server_updated_at: entry.metadata._server.updated_at,
                remote_updated_at: remote.updatedAt,
              });
              continue;
            }
            stale.push({
              kind: "project",
              id: entry.id,
              name: entry.metadata.name,
              server_updated_at: entry.metadata._server.updated_at,
              remote_updated_at: remote.updatedAt,
            });
          }
        }
      }
      staleCheck = "ok";
    } catch (err) {
      staleCheck = "errored";
      staleCheckError = err instanceof Error ? err.message : String(err);
    }
  }

  const staleIssueIds = new Set(
    stale.filter((entry) => entry.kind === "issue").map((entry) => entry.identifier),
  );
  const staleProjectIds = new Set(
    stale.filter((entry) => entry.kind === "project").map((entry) => entry.id),
  );
  const conflictedCleanIssueIds = new Set(
    remoteConflicts
      .filter(
        (entry): entry is CacheStatusRemoteConflictIssue =>
          entry.kind === "issue" && entry.local_status === "clean",
      )
      .map((entry) => entry.identifier),
  );
  const conflictedCleanProjectIds = new Set(
    remoteConflicts
      .filter(
        (entry): entry is CacheStatusRemoteConflictProject =>
          entry.kind === "project" && entry.local_status === "clean",
      )
      .map((entry) => entry.id),
  );
  const integrityProblems = await inspectCacheIntegrity(input.repoHash);

  return {
    team: input.team,
    repo_root: input.repoRoot,
    repo_hash: input.repoHash,
    modified: {
      issues: modifiedIssues.map((entry) => ({
        identifier: entry.id,
        fields: entry.changes.map((change) => change.field),
      })),
      projects: modifiedProjects.map((entry) => ({
        id: entry.id,
        name: entry.metadata.name,
        fields: entry.changes.map((change) => change.field),
      })),
    },
    stale,
    remote_conflicts: remoteConflicts,
    stale_check: staleCheck,
    ...(staleCheckError ? { stale_check_error: staleCheckError } : {}),
    clean: {
      issues: cleanIssues
        .filter((entry) => !staleIssueIds.has(entry.id) && !conflictedCleanIssueIds.has(entry.id))
        .map((entry) => entry.id),
      projects: cleanProjects
        .filter(
          (entry) => !staleProjectIds.has(entry.id) && !conflictedCleanProjectIds.has(entry.id),
        )
        .map((entry) => entry.id),
    },
    integrity: {
      ok: integrityProblems.length === 0,
      problems: integrityProblems,
    },
  };
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}
