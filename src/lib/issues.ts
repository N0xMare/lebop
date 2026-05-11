/**
 * Issue lifecycle wrappers shared by the CLI and MCP surfaces.
 *
 * All field resolution (state name → state UUID, label name → label UUID,
 * priority name → enum, assignee name → user UUID) happens here against
 * cached `TeamMetadata`, so callers pass the raw user-facing strings and
 * receive Linear-API-shaped responses back.
 */

import type { TeamMetadata } from "./cache.ts";
import { rewriteNotFound } from "./errors.ts";
import { buildPullIssuesQuery, type FetchedIssue, type FetchedProject } from "./pullQuery.ts";
import {
  getTeamMetadata,
  ResolveError,
  resolveAssigneeId,
  resolveLabelIds,
  resolvePriority,
  resolveStateId,
  withFreshMetadataOnMiss,
} from "./resolve.ts";
import { linear, withClient } from "./sdk.ts";

export interface CreateIssueInput {
  /** Required when no team default has been resolved by the caller. */
  team: string;
  title: string;
  description?: string;
  /** Project name (resolved against the team's projects). */
  project?: string;
  /** Project UUID (skips name resolution). */
  projectId?: string;
  /** State name; defaults to the team's default state. */
  state?: string;
  /** Priority — `none|urgent|high|normal|low` or `0..4`. */
  priority?: string | number;
  estimate?: number;
  /** Label names; resolved against team labels. */
  labels?: string[];
  /** `me` / email / display-name. */
  assignee?: string;
  /** repoHash for team-metadata cache key (defaults to `_global`). */
  repoHash?: string;
}

export interface CreatedIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  state: { name: string };
  project: { name: string } | null;
}

const CREATE_MUTATION = /* GraphQL */ `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        url
        title
        state { name }
        project { name }
      }
    }
  }
`;

function resolveProjectByName(
  teamMetadata: { projects: { id: string; name: string }[] },
  projectName: string | undefined,
): string | undefined {
  if (!projectName) return undefined;
  const match = teamMetadata.projects.find(
    (p) => p.name.toLowerCase() === projectName.toLowerCase(),
  );
  if (!match) {
    const names = teamMetadata.projects.map((p) => `"${p.name}"`).join(", ");
    throw new ResolveError(`unknown project "${projectName}". available: ${names}`);
  }
  return match.id;
}

export async function createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
  const repoHash = input.repoHash ?? "_global";
  const priority = input.priority !== undefined ? resolvePriority(input.priority) : undefined;

  const { teamMetadata, labelIds, stateId, assigneeId, projectId } = await withFreshMetadataOnMiss(
    (o) => getTeamMetadata(repoHash, input.team, o),
    async (md: TeamMetadata) => ({
      teamMetadata: md,
      labelIds: input.labels?.length ? resolveLabelIds(md, input.labels) : undefined,
      stateId: input.state ? resolveStateId(md, input.state) : undefined,
      assigneeId: input.assignee ? await resolveAssigneeId(md, input.assignee) : undefined,
      projectId: input.projectId ?? resolveProjectByName(md, input.project),
    }),
  );

  const linearInput: Record<string, unknown> = {
    teamId: teamMetadata.team_id,
    title: input.title,
  };
  if (input.description !== undefined) linearInput.description = input.description;
  if (stateId !== undefined) linearInput.stateId = stateId;
  if (priority !== undefined) linearInput.priority = priority;
  if (input.estimate !== undefined) linearInput.estimate = input.estimate;
  if (labelIds !== undefined) linearInput.labelIds = labelIds;
  if (assigneeId !== undefined) linearInput.assigneeId = assigneeId;
  if (projectId !== undefined) linearInput.projectId = projectId;

  // issueCreate is NOT wrapped with retry — duplicate creation could result.
  const client = await linear();
  const response = (await client.client.rawRequest(CREATE_MUTATION, { input: linearInput })) as {
    data: { issueCreate: { success: boolean; issue: CreatedIssue } };
  };
  return response.data.issueCreate.issue;
}

export interface UpdateIssueInput {
  identifier: string;
  team?: string;
  repoHash?: string;
  title?: string;
  description?: string;
  state?: string;
  priority?: string | number;
  estimate?: number | null;
  labels?: string[];
  assignee?: string | null;
  parent?: string | null;
}

export interface UpdatedIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  state: { name: string };
}

const UPDATE_MUTATION = /* GraphQL */ `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        url
        title
        state { name }
      }
    }
  }
`;

export async function updateIssue(input: UpdateIssueInput): Promise<UpdatedIssue> {
  const repoHash = input.repoHash ?? "_global";
  // Resolve issue identifier → UUID (idempotent read; wrapped with retry).
  const issue = await withClient((c) => c.issue(input.identifier));
  if (!issue) throw new Error(`issue not found: ${input.identifier}`);

  const { stateId, assigneeId, labelIds, parentId } = input.team
    ? await withFreshMetadataOnMiss(
        (o) => getTeamMetadata(repoHash, input.team as string, o),
        async (md: TeamMetadata) => ({
          stateId: input.state ? resolveStateId(md, input.state) : undefined,
          assigneeId:
            input.assignee === null
              ? null
              : input.assignee
                ? await resolveAssigneeId(md, input.assignee)
                : undefined,
          labelIds: input.labels ? resolveLabelIds(md, input.labels) : undefined,
          parentId:
            input.parent === null
              ? null
              : input.parent
                ? (await withClient((c) => c.issue(input.parent as string)))?.id
                : undefined,
        }),
      )
    : { stateId: undefined, assigneeId: undefined, labelIds: undefined, parentId: undefined };

  const priority = input.priority !== undefined ? resolvePriority(input.priority) : undefined;

  const linearInput: Record<string, unknown> = {};
  if (input.title !== undefined) linearInput.title = input.title;
  if (input.description !== undefined) linearInput.description = input.description;
  if (stateId !== undefined) linearInput.stateId = stateId;
  if (priority !== undefined) linearInput.priority = priority;
  if (input.estimate !== undefined) linearInput.estimate = input.estimate;
  if (labelIds !== undefined) linearInput.labelIds = labelIds;
  if (assigneeId !== undefined) linearInput.assigneeId = assigneeId;
  if (parentId !== undefined) linearInput.parentId = parentId;

  if (Object.keys(linearInput).length === 0) {
    throw new Error("nothing to update — pass at least one field");
  }

  // issueUpdate is idempotent at the value level — retry-wrapped.
  try {
    const response = (await withClient((c) =>
      c.client.rawRequest(UPDATE_MUTATION, { id: issue.id, input: linearInput }),
    )) as { data: { issueUpdate: { success: boolean; issue: UpdatedIssue } } };
    return response.data.issueUpdate.issue;
  } catch (err) {
    throw rewriteNotFound(err, input.identifier);
  }
}

const ARCHIVE_MUTATION = /* GraphQL */ `
  mutation ArchiveIssue($id: String!) {
    issueArchive(id: $id) { success }
  }
`;

const UNARCHIVE_MUTATION = /* GraphQL */ `
  mutation UnarchiveIssue($id: String!) {
    issueUnarchive(id: $id) { success }
  }
`;

export type LifecycleStatus = "ok" | "not-found" | "error";
export interface LifecycleResult {
  identifier: string;
  status: LifecycleStatus;
  error?: string;
}

async function lifecycleOne(
  identifier: string,
  mutation: string,
  _verb: "archive" | "unarchive",
): Promise<LifecycleResult> {
  try {
    const issue = await withClient((c) => c.issue(identifier));
    if (!issue) return { identifier, status: "not-found" };
    const client = await linear();
    await client.client.rawRequest(mutation, { id: issue.id });
    return { identifier, status: "ok" };
  } catch (err) {
    const translated = rewriteNotFound(err, identifier);
    if (translated.message.startsWith("not found:")) {
      return { identifier, status: "not-found" };
    }
    return { identifier, status: "error", error: translated.message };
  }
}

export async function archiveIssues(identifiers: string[]): Promise<LifecycleResult[]> {
  const results: LifecycleResult[] = [];
  for (const id of identifiers) {
    results.push(await lifecycleOne(id, ARCHIVE_MUTATION, "archive"));
  }
  return results;
}

export async function unarchiveIssues(identifiers: string[]): Promise<LifecycleResult[]> {
  const results: LifecycleResult[] = [];
  for (const id of identifiers) {
    results.push(await lifecycleOne(id, UNARCHIVE_MUTATION, "unarchive"));
  }
  return results;
}

export async function getIssue(identifier: string): Promise<FetchedIssue | null> {
  const upperId = identifier.toUpperCase();
  const query = buildPullIssuesQuery([upperId], false);
  try {
    const response = (await withClient((c) => c.client.rawRequest(query))) as {
      data: Record<string, FetchedIssue | null>;
    };
    return response.data.a0 ?? null;
  } catch (err) {
    throw rewriteNotFound(err, upperId);
  }
}

export type { FetchedIssue, FetchedProject };
