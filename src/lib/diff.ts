import { createTwoFilesPatch } from "diff";
import { buildIssueMetadata, buildProjectMetadata } from "./build.ts";
import {
  type IssueMetadata,
  type ProjectMetadata,
  readIssue,
  readProject,
  sha256,
} from "./cache.ts";
import { resolveConfig } from "./config.ts";
import { NotFoundError, rewriteNotFound } from "./errors.ts";
import { getProject } from "./projects.ts";
import { buildPullIssuesQuery, type FetchedIssue } from "./pullQuery.ts";
import { deriveTeamFromIdentifiers } from "./resolve.ts";
import { withClient } from "./sdk.ts";

export type IssueField =
  | "title"
  | "description"
  | "state"
  | "priority"
  | "estimate"
  | "labels"
  | "assignee"
  | "project"
  | "milestone"
  | "cycle"
  | "parent";

export interface IssueChange {
  field: IssueField;
  from: unknown;
  to: unknown;
}

export interface FieldDiff {
  field: string;
  local: unknown;
  remote: unknown;
}

export interface IssueCacheRemoteDiff extends Record<string, unknown> {
  identifier: string;
  requested_identifier: string;
  fields: FieldDiff[];
  description_changed: boolean;
  description_patch: string | null;
}

export interface ProjectCacheRemoteDiff extends Record<string, unknown> {
  project_id: string;
  name: string;
  fields: FieldDiff[];
  content_changed: boolean;
  content_patch: string | null;
}

export interface CacheRemoteDiffInput {
  repoRoot?: string;
  team?: string;
}

export function diffIssueMetadata(metadata: IssueMetadata, description: string): IssueChange[] {
  const s = metadata._server;
  const changes: IssueChange[] = [];

  if (metadata.title !== s.title) {
    changes.push({ field: "title", from: s.title, to: metadata.title });
  }

  const localDescHash = sha256(description);
  if (localDescHash !== s.description_hash) {
    changes.push({ field: "description", from: "<unchanged>", to: "<edited>" });
  }

  if (metadata.state !== s.state_name) {
    changes.push({ field: "state", from: s.state_name, to: metadata.state });
  }

  if (metadata.priority !== s.priority) {
    changes.push({ field: "priority", from: s.priority, to: metadata.priority });
  }

  if ((metadata.estimate ?? null) !== (s.estimate ?? null)) {
    changes.push({ field: "estimate", from: s.estimate, to: metadata.estimate });
  }

  const localLabels = [...metadata.labels].sort();
  const remoteLabels = s.label_ids.map((l) => l.name).sort();
  if (!arraysEqual(localLabels, remoteLabels)) {
    changes.push({ field: "labels", from: remoteLabels, to: localLabels });
  }

  const localAssignee = metadata.assignee;
  const remoteAssignee = s.assignee_email ?? s.assignee_name;
  if ((localAssignee ?? null) !== (remoteAssignee ?? null)) {
    changes.push({ field: "assignee", from: remoteAssignee, to: localAssignee });
  }

  if ((metadata.project ?? null) !== (s.project_name ?? null)) {
    changes.push({ field: "project", from: s.project_name, to: metadata.project });
  }

  if ((metadata.milestone ?? null) !== (s.project_milestone_name ?? null)) {
    changes.push({ field: "milestone", from: s.project_milestone_name, to: metadata.milestone });
  }

  if ((metadata.cycle ?? null) !== (s.cycle_name ?? null)) {
    changes.push({ field: "cycle", from: s.cycle_name, to: metadata.cycle });
  }

  if ((metadata.parent ?? null) !== (s.parent_identifier ?? null)) {
    changes.push({ field: "parent", from: s.parent_identifier, to: metadata.parent });
  }

  return changes;
}

export type ProjectField =
  | "name"
  | "description"
  | "icon"
  | "start_date"
  | "target_date"
  | "state"
  | "content";

export interface ProjectChange {
  field: ProjectField;
  from: unknown;
  to: unknown;
}

export function diffProjectMetadata(metadata: ProjectMetadata, content: string): ProjectChange[] {
  const s = metadata._server;
  const changes: ProjectChange[] = [];
  if (metadata.name !== s.name) changes.push({ field: "name", from: s.name, to: metadata.name });
  if (metadata.description !== s.description) {
    changes.push({ field: "description", from: s.description, to: metadata.description });
  }
  if ((metadata.icon ?? null) !== (s.icon ?? null)) {
    changes.push({ field: "icon", from: s.icon, to: metadata.icon });
  }
  if ((metadata.start_date ?? null) !== (s.start_date ?? null)) {
    changes.push({ field: "start_date", from: s.start_date, to: metadata.start_date });
  }
  if ((metadata.target_date ?? null) !== (s.target_date ?? null)) {
    changes.push({ field: "target_date", from: s.target_date, to: metadata.target_date });
  }
  if (metadata.state !== s.state) {
    changes.push({ field: "state", from: s.state, to: metadata.state });
  }
  const localContentHash = sha256(content);
  if (localContentHash !== s.content_hash) {
    changes.push({ field: "content", from: "<unchanged>", to: "<edited>" });
  }
  return changes;
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function diffIssueCacheVsRemote(
  identifier: string,
  input: CacheRemoteDiffInput = {},
): Promise<IssueCacheRemoteDiff> {
  const requested = identifier.toUpperCase();
  const teamOverride = input.team ?? deriveTeamFromIdentifiers([requested]) ?? undefined;
  const config = await resolveConfig({
    cwd: input.repoRoot,
    teamOverride,
    requireGitRoot: Boolean(input.repoRoot),
  });

  const query = buildPullIssuesQuery([requested], false);
  let response: { data: Record<string, FetchedIssue | null> };
  try {
    response = (await withClient((c) => c.client.rawRequest(query))) as {
      data: Record<string, FetchedIssue | null>;
    };
  } catch (err) {
    throw rewriteNotFound(err, requested);
  }
  const remoteNode = response.data.a0;
  if (!remoteNode) {
    throw new NotFoundError(`not found: ${requested}`, `verify ${requested} exists on Linear`);
  }

  const canonical = remoteNode.identifier.toUpperCase();
  const local =
    (await readIssue(config.repoHash, canonical)) ??
    (canonical !== requested ? await readIssue(config.repoHash, requested) : null);
  if (!local) {
    throw new NotFoundError(
      `${canonical} is not in the local cache. run \`lebop pull ${canonical}\` first.`,
    );
  }

  const { metadata: remoteMeta } = buildIssueMetadata(remoteNode);
  const remoteBody = remoteNode.description ?? "";
  const fields = diffIssueFields(local.metadata, remoteMeta);
  const patch = createTwoFilesPatch(
    `a/${canonical}/description.md`,
    `b/${canonical}/description.md`,
    remoteBody,
    local.description,
    "remote (live)",
    "local (cache)",
    { context: 3 },
  );
  const descriptionChanged = patchHasChanges(patch);

  return {
    identifier: canonical,
    requested_identifier: requested,
    fields,
    description_changed: descriptionChanged,
    description_patch: descriptionChanged ? patch : null,
  };
}

export async function diffProjectCacheVsRemote(
  projectId: string,
  input: CacheRemoteDiffInput = {},
): Promise<ProjectCacheRemoteDiff> {
  const config = await resolveConfig({
    cwd: input.repoRoot,
    teamOverride: input.team,
    requireGitRoot: Boolean(input.repoRoot),
  });
  const local = await readProject(config.repoHash, projectId);
  if (!local) {
    throw new NotFoundError(
      `project/${projectId} is not in the local cache. run \`lebop pull --project-id ${projectId}\` first.`,
    );
  }

  const remote = await getProject(projectId);
  if (!remote) throw new NotFoundError(`project not found: ${projectId}`);
  const { metadata: remoteMeta, content: remoteContent } = buildProjectMetadata({
    id: remote.id,
    name: remote.name,
    description: remote.description ?? "",
    content: remote.content,
    icon: remote.icon,
    startDate: remote.start_date,
    targetDate: remote.target_date,
    state: remote.state,
    url: remote.url,
    updatedAt: remote.updated_at,
    issues: { nodes: [] },
  });
  const remoteFields = diffProjectFields(local.metadata, remoteMeta);
  const patch = createTwoFilesPatch(
    `a/project-${projectId}/content.md`,
    `b/project-${projectId}/content.md`,
    remoteContent,
    local.content,
    "remote (live)",
    "local (cache)",
    { context: 3 },
  );
  const contentChanged = patchHasChanges(patch);
  const fields = contentChanged
    ? [...remoteFields, { field: "content", local: local.content, remote: remoteContent }]
    : remoteFields;

  return {
    project_id: projectId,
    name: local.metadata.name,
    fields,
    content_changed: contentChanged,
    content_patch: contentChanged ? patch : null,
  };
}

export function diffIssueFields(local: IssueMetadata, remote: IssueMetadata): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (local.title !== remote.title) {
    diffs.push({ field: "title", local: local.title, remote: remote.title });
  }
  if (local.state !== remote.state) {
    diffs.push({ field: "state", local: local.state, remote: remote.state });
  }
  if (local.priority !== remote.priority) {
    diffs.push({ field: "priority", local: local.priority, remote: remote.priority });
  }
  if ((local.estimate ?? null) !== (remote.estimate ?? null)) {
    diffs.push({ field: "estimate", local: local.estimate, remote: remote.estimate });
  }
  const localLabels = [...local.labels].sort();
  const remoteLabels = [...remote.labels].sort();
  if (!arraysEqual(localLabels, remoteLabels)) {
    diffs.push({ field: "labels", local: localLabels, remote: remoteLabels });
  }
  if ((local.assignee ?? null) !== (remote.assignee ?? null)) {
    diffs.push({ field: "assignee", local: local.assignee, remote: remote.assignee });
  }
  if ((local.project ?? null) !== (remote.project ?? null)) {
    diffs.push({ field: "project", local: local.project, remote: remote.project });
  }
  if ((local.milestone ?? null) !== (remote.milestone ?? null)) {
    diffs.push({ field: "milestone", local: local.milestone, remote: remote.milestone });
  }
  if ((local.cycle ?? null) !== (remote.cycle ?? null)) {
    diffs.push({ field: "cycle", local: local.cycle, remote: remote.cycle });
  }
  if ((local.parent ?? null) !== (remote.parent ?? null)) {
    diffs.push({ field: "parent", local: local.parent, remote: remote.parent });
  }
  return diffs;
}

export function diffProjectFields(local: ProjectMetadata, remote: ProjectMetadata): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (local.name !== remote.name) {
    diffs.push({ field: "name", local: local.name, remote: remote.name });
  }
  if (local.description !== remote.description) {
    diffs.push({ field: "description", local: local.description, remote: remote.description });
  }
  if ((local.icon ?? null) !== (remote.icon ?? null)) {
    diffs.push({ field: "icon", local: local.icon, remote: remote.icon });
  }
  if ((local.start_date ?? null) !== (remote.start_date ?? null)) {
    diffs.push({ field: "start_date", local: local.start_date, remote: remote.start_date });
  }
  if ((local.target_date ?? null) !== (remote.target_date ?? null)) {
    diffs.push({ field: "target_date", local: local.target_date, remote: remote.target_date });
  }
  if (local.state !== remote.state) {
    diffs.push({ field: "state", local: local.state, remote: remote.state });
  }
  return diffs;
}

export function patchHasChanges(patch: string): boolean {
  return patch
    .split("\n")
    .some(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    );
}
