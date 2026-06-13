/**
 * Issue lifecycle wrappers shared by the CLI and MCP surfaces.
 *
 * All field resolution (state name → state UUID, label name → label UUID,
 * priority name → enum, assignee name → user UUID) happens here against
 * cached `TeamMetadata`, so callers pass the raw user-facing strings and
 * receive Linear-API-shaped responses back.
 */

import type { TeamMetadata } from "./cache.ts";
import { NotFoundError, rewriteNotFound, tryMapToNull, ValidationError } from "./errors.ts";
import { requireMutationEntity, requireMutationSuccess } from "./mutationResult.ts";
import {
  buildPullIssuesQuery,
  type FetchedIssue,
  type FetchedProject,
  ISSUE_FIELDS_FRAGMENT,
} from "./pullQuery.ts";
import {
  deriveTeamFromIdentifiers,
  getTeamMetadata,
  ResolveError,
  resolveAssigneeId,
  resolveCycleIdByName,
  resolveLabelId,
  resolveLabelIds,
  resolveMilestoneIdByName,
  resolvePriority,
  resolveProjectIdByName,
  resolveStateId,
  withFreshMetadataOnMiss,
} from "./resolve.ts";
import { linear, withClient } from "./sdk.ts";
import { isUuid } from "./uuid.ts";

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

/**
 * Resolve a Linear issue identifier (e.g. "NOX-42") to a minimal
 * `{id, identifier}` shape via a hand-rolled query. Avoids the 60+ field
 * fragment that the SDK-typed `c.issue(id)` ships, which instantiates
 * IssueSharedAccess and a half-dozen sibling classes from per-field data —
 * brittle to mock and expensive on the wire. Returns `null` if Linear has
 * no such issue.
 *
 * Wave 3: introduced when updateIssue absorbed project/milestone/cycle so
 * the whole lib path is one identifier → UUID round-trip + one mutation.
 */
async function resolveIssueIdByIdentifier(identifier: string): Promise<{
  id: string;
  identifier: string;
  project?: { id: string; name: string } | null;
  labels?: { nodes: { id: string; name: string }[] } | null;
} | null> {
  const QUERY = /* GraphQL */ `
    query ResolveIssueId($id: String!) {
      issue(id: $id) {
        id
        identifier
        project { id name }
        labels { nodes { id name } }
      }
    }
  `;
  try {
    const response = (await withClient((c) => c.client.rawRequest(QUERY, { id: identifier }))) as {
      data: {
        issue: {
          id: string;
          identifier: string;
          project?: { id: string; name: string } | null;
          labels?: { nodes: { id: string; name: string }[] } | null;
        } | null;
      };
    };
    return response.data.issue ?? null;
  } catch (err) {
    // Linear's `issue(id)` resolver throws "Entity not found" for unknown
    // identifiers; surface as null so the caller can choose its own error
    // shape (lib/updateIssue throws NotFoundError; resolveCycle/Milestone
    // throws their own ResolveError).
    if (err instanceof NotFoundError) return null;
    throw err;
  }
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
  const match = resolveCachedProjectIdByName(teamMetadata, projectName);
  if (match === null) {
    const names = teamMetadata.projects.map((p) => `"${p.name}"`).join(", ");
    throw new ResolveError(`unknown project "${projectName}". available: ${names}`);
  }
  return match;
}

function resolveCachedProjectIdByName(
  teamMetadata: { projects: { id: string; name: string }[] },
  projectName: string,
): string | null {
  const lowerName = projectName.toLowerCase();
  const matches = teamMetadata.projects.filter((p) => p.name.toLowerCase() === lowerName);
  if (matches.length > 1) {
    const candidates = matches.map((p) => `${p.name} (${p.id})`).join(", ");
    throw new ResolveError(
      `ambiguous project "${projectName}" in team cache matches: ${candidates}`,
      "pass the project UUID instead of the project name",
    );
  }
  return matches[0]?.id ?? null;
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
  return requireMutationEntity<CreatedIssue>(
    "issueCreate",
    response.data.issueCreate as unknown as { success?: boolean } & Record<string, unknown>,
    "issue",
  );
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
  labelDeltas?: {
    add?: string[];
    remove?: string[];
  };
  assignee?: string | null;
  parent?: string | null;
  /**
   * Project name OR UUID. Pass `null` to detach the issue from its
   * current project. Resolved via the team-metadata cache (name → UUID).
   * Wave 3: moved from MCP server-local resolution into the lib so CLI
   * and MCP share one path.
   */
  project?: string | null;
  /**
   * Project-milestone name OR UUID. Pass `null` to clear. Milestone must
   * belong to the issue's project — Linear enforces that server-side.
   * Wave 3: resolver moved from MCP server into lib/resolve.ts.
   */
  milestone?: string | null;
  /**
   * Cycle name OR UUID. Pass `null` to remove. NAME lookups are
   * team-scoped (cycle names aren't unique across teams) — `team` must
   * be provided when passing a name. UUID inputs skip team scoping.
   */
  cycle?: string | null;
}

export type UpdatedIssue = FetchedIssue;

export interface IssueWriteProof {
  id: string;
  identifier: string;
  url: string | null;
  updated_at: string | null;
  title: string | null;
  description: string | null;
  state: { id: string | null; name: string; type: string | null } | null;
  priority: number | null;
  estimate: number | null;
  labels: { id: string; name: string }[];
  assignee: { id: string; name: string; email: string } | null;
  parent: { id: string; identifier: string } | null;
  project: { id: string; name: string } | null;
  milestone: { id: string; name: string } | null;
  cycle: { id: string; name: string } | null;
}

type IssueWriteProofSource = {
  id: string;
  identifier: string;
  url?: string | null;
  updatedAt?: string | null;
  title?: string | null;
  description?: string | null;
  state?: { id?: string | null; name: string; type?: string | null } | null;
  priority?: number | null;
  estimate?: number | null;
  labels?: { nodes?: { id: string; name: string }[] } | null;
  assignee?: { id: string; name: string; email: string } | null;
  parent?: { id: string; identifier: string } | null;
  project?: { id: string; name: string } | null;
  projectMilestone?: { id: string; name: string } | null;
  cycle?: { id: string; name: string } | null;
};

export function issueWriteProof(issue: IssueWriteProofSource): IssueWriteProof {
  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url ?? null,
    updated_at: issue.updatedAt ?? null,
    title: issue.title ?? null,
    description: issue.description ?? null,
    state: issue.state
      ? {
          id: issue.state.id ?? null,
          name: issue.state.name,
          type: issue.state.type ?? null,
        }
      : null,
    priority: issue.priority ?? null,
    estimate: issue.estimate ?? null,
    labels: issue.labels?.nodes ?? [],
    assignee: issue.assignee ?? null,
    parent: issue.parent ?? null,
    project: issue.project ?? null,
    milestone: issue.projectMilestone ?? null,
    cycle: issue.cycle ?? null,
  };
}

const UPDATE_MUTATION = /* GraphQL */ `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        ...IssueFields
      }
    }
  }
  ${ISSUE_FIELDS_FRAGMENT}
`;

export async function updateIssue(input: UpdateIssueInput): Promise<UpdatedIssue> {
  const repoHash = input.repoHash ?? "_global";
  // Resolve issue identifier → UUID/current-project via a minimal raw query (idempotent read;
  // retry-wrapped via withClient). The SDK-typed `c.issue(id)` would request
  // a 60+ field fragment + instantiate IssueSharedAccess / etc., which is
  // overkill for a UUID lookup. We just need the id.
  const issue = await resolveIssueIdByIdentifier(input.identifier);
  if (!issue) {
    throw new NotFoundError(
      `issue not found: ${input.identifier}`,
      "verify the identifier or your team scope",
    );
  }

  // Round-6 / C3: derive team from the canonical Linear identifier
  // (TEAM-NN form) so name-shaped fields (state, labels, string-assignee)
  // resolve without an explicit `team` arg — the CLI surface enforces team
  // via `resolveConfig` but the MCP surface previously silently dropped
  // these fields when team was missing. Pattern mirrors bulk.ts:118-137.
  // The `issue.identifier` from Linear's resolver is always canonical
  // TEAM-NN regardless of what the user passed (UUID inputs return canonical).
  // Fall back to `input.identifier` for older mock paths that don't echo it.
  let derivedTeam: string | null = null;
  try {
    derivedTeam = deriveTeamFromIdentifiers([issue.identifier ?? input.identifier]);
  } catch {
    // identifier wasn't TEAM-NN shaped; rare in practice (Linear's resolver
    // canonicalizes). Stay defensive — needsTeamScope check below will
    // surface a loud error if team is required but couldn't be derived.
  }
  const teamKey = input.team ?? derivedTeam ?? undefined;

  // Only state / labels / string-assignee require team metadata. parent is
  // workspace-wide (resolveIssueIdByIdentifier), milestone is scoped to the
  // target/current project below, and cycle is checked separately
  // (resolveCycleIdByName already throws loudly for name-without-team).
  // null-clear paths (assignee:null, labels:null, parent:null) don't need
  // team since they're "set to null" operations.
  // Round-7 / HIGH-1: `@me` and `me` don't need team scope — `resolveAssigneeId`
  // uses the workspace-wide viewer query for those tokens (see resolve.ts).
  // Match the `bulk.ts:121-123` predicate exactly so the two surfaces agree
  // on what triggers the team-required gate.
  const needsTeamScope =
    input.state !== undefined ||
    input.labels !== undefined ||
    hasLabelDeltas(input.labelDeltas) ||
    (typeof input.assignee === "string" && input.assignee !== "@me" && input.assignee !== "me");
  if (needsTeamScope && !teamKey) {
    throw new ValidationError(
      "update_issue: state / labels / assignee resolution requires a team",
      "pass team explicitly, or use a TEAM-NN identifier we can derive from",
    );
  }

  // Resolve parent OUTSIDE the team-gated block — workspace-wide identifier
  // lookup, never needs team metadata. (Previously gated incorrectly.)
  let parentId: string | null | undefined;
  if (input.parent === undefined) {
    parentId = undefined;
  } else if (input.parent === null) {
    parentId = null;
  } else {
    const parent = await resolveIssueIdByIdentifier(input.parent);
    if (!parent) {
      throw new NotFoundError(
        `parent issue not found: ${input.parent}`,
        "verify the parent issue identifier, or pass parent:null to clear the existing parent",
      );
    }
    parentId = parent.id;
  }

  // Round-7 / HIGH-1: same hoist for `@me`/`me` assignee. `resolveAssigneeId`
  // resolves these via the workspace-wide viewer query — no team needed.
  // Without hoisting, the team-metadata closure below would silently skip
  // (when enterTeamMetadata is false) and the assignee field would be
  // dropped from linearInput. Inline the viewer-resolution to avoid the
  // team-metadata placeholder dance.
  let viewerAssigneeId: string | undefined;
  if (typeof input.assignee === "string" && (input.assignee === "@me" || input.assignee === "me")) {
    const viewer = await withClient((c) => c.viewer);
    viewerAssigneeId = viewer.id;
  }

  // Resolve all name → UUID lookups BEFORE firing any mutation: a bad
  // milestone name shouldn't leave the issue with a half-applied update.
  //
  // Decide whether to enter the team-metadata closure:
  //   - If the caller passed `team` EXPLICITLY: always enter (preserves the
  //     pre-round-6 team-cache-first project-name lookup — wave-3 test at
  //     tests/issues.test.ts depends on this).
  //   - If `team` was only DERIVED from the identifier: enter only when one
  //     of the name-shaped fields actually needs it (state / labels /
  //     string-assignee). Project-by-name uses a strict resolver below; a
  //     derived identifier team is not treated as an explicit project scope.
  const enterTeamMetadata = !!teamKey && (input.team !== undefined || needsTeamScope);
  const { stateId, assigneeId, labelIds, projectIdFromName } =
    enterTeamMetadata && teamKey
      ? await withFreshMetadataOnMiss(
          (o) => getTeamMetadata(repoHash, teamKey, o),
          async (md: TeamMetadata) => ({
            stateId: input.state ? resolveStateId(md, input.state) : undefined,
            // Round-8 backlog / N1: skip the redundant viewer query when
            // the hoist above already resolved `@me`/`me` to viewer.id.
            // Pre-fix, `update_issue identifier:ENG-1 assignee:@me
            // state:Backlog` ran the viewer query TWICE (once in the
            // hoist, once inside `resolveAssigneeId` via the closure).
            // The viewerAssigneeId precedence at the linearInput assembly
            // below means the closure's value is dead anyway — short-
            // circuit to avoid the round-trip.
            assigneeId:
              input.assignee === null
                ? null
                : viewerAssigneeId !== undefined
                  ? undefined
                  : input.assignee
                    ? await resolveAssigneeId(md, input.assignee)
                    : undefined,
            labelIds:
              input.labels !== undefined
                ? resolveLabelIds(md, input.labels)
                : resolveLabelDeltas(md, issue.labels?.nodes ?? [], input.labelDeltas),
            // Project resolution uses the team-scoped metadata cache only
            // when the caller supplied `team` explicitly. A derived identifier
            // team is not enough to disambiguate duplicate workspace names.
            projectIdFromName: ((): string | null | undefined => {
              const p = input.project;
              if (input.team === undefined || typeof p !== "string" || isUuid(p)) return undefined;
              return resolveCachedProjectIdByName(md, p);
            })(),
          }),
        )
      : {
          stateId: undefined,
          // Preserve null-clear semantics outside the team-gated block.
          assigneeId: input.assignee === null ? null : undefined,
          labelIds: undefined,
          projectIdFromName: undefined,
        };

  // Resolve project / milestone / cycle outside the team-metadata block so
  // all name lookups happen before any mutation. Cycle names use the derived
  // TEAM-NN scope when available; UUID inputs skip that requirement.
  let projectId: string | null | undefined;
  if (input.project === undefined) {
    projectId = undefined;
  } else if (input.project === null) {
    projectId = null;
  } else if (isUuid(input.project)) {
    projectId = input.project;
  } else {
    // Name input — `projectIdFromName` is the explicit-team cache fast path.
    // On miss, resolve live with the explicit team only if the caller supplied
    // one. With no explicit team, workspace duplicate names fail loudly.
    if (projectIdFromName) {
      projectId = projectIdFromName;
    } else {
      try {
        projectId = await resolveProjectIdByName(input.project, {
          teamKey: input.team !== undefined ? teamKey : undefined,
        });
      } catch (err) {
        if (err instanceof ResolveError) {
          throw new ValidationError(err.message, err.hint);
        }
        throw err;
      }
    }
  }

  let milestoneId: string | null | undefined;
  if (input.milestone === undefined) {
    milestoneId = undefined;
  } else if (input.milestone === null) {
    milestoneId = null;
  } else {
    const milestoneProjectId =
      projectId === null ? null : projectId !== undefined ? projectId : (issue.project?.id ?? null);
    if (!isUuid(input.milestone) && !milestoneProjectId) {
      throw new ResolveError(
        `milestone name "${input.milestone}" requires a project scope`,
        "set a project in the same call, keep the issue attached to a project, or use the milestone UUID",
      );
    }
    milestoneId = await resolveMilestoneIdByName(input.milestone, {
      projectId: milestoneProjectId,
    });
  }

  let cycleId: string | null | undefined;
  if (input.cycle === undefined) {
    cycleId = undefined;
  } else if (input.cycle === null) {
    cycleId = null;
  } else {
    cycleId = await resolveCycleIdByName(input.cycle, teamKey);
  }

  const priority = input.priority !== undefined ? resolvePriority(input.priority) : undefined;

  const linearInput: Record<string, unknown> = {};
  if (input.title !== undefined) linearInput.title = input.title;
  if (input.description !== undefined) linearInput.description = input.description;
  if (stateId !== undefined) linearInput.stateId = stateId;
  if (priority !== undefined) linearInput.priority = priority;
  if (input.estimate !== undefined) linearInput.estimate = input.estimate;
  if (labelIds !== undefined) linearInput.labelIds = labelIds;
  // Round-7 / HIGH-1: viewer-resolved `@me`/`me` wins over the closure's
  // team-scoped assignee (which is `undefined` when the closure was skipped
  // — `needsTeamScope` returns false for `@me`/`me` so the closure may not run).
  if (viewerAssigneeId !== undefined) linearInput.assigneeId = viewerAssigneeId;
  else if (assigneeId !== undefined) linearInput.assigneeId = assigneeId;
  if (parentId !== undefined) linearInput.parentId = parentId;
  if (projectId !== undefined) linearInput.projectId = projectId;
  if (milestoneId !== undefined) linearInput.projectMilestoneId = milestoneId;
  if (cycleId !== undefined) linearInput.cycleId = cycleId;

  if (Object.keys(linearInput).length === 0) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass at least one of title, description, state, priority, estimate, labels, assignee, parent, project, milestone, cycle",
    );
  }

  // issueUpdate is idempotent at the value level — retry-wrapped.
  try {
    const response = (await withClient((c) =>
      c.client.rawRequest(UPDATE_MUTATION, { id: issue.id, input: linearInput }),
    )) as { data: { issueUpdate: { success: boolean; issue: UpdatedIssue } } };
    return requireMutationEntity<UpdatedIssue>(
      "issueUpdate",
      response.data.issueUpdate as unknown as { success?: boolean } & Record<string, unknown>,
      "issue",
    );
  } catch (err) {
    throw rewriteNotFound(err, input.identifier);
  }
}

function hasLabelDeltas(input: UpdateIssueInput["labelDeltas"]): boolean {
  return Boolean(input && ((input.add?.length ?? 0) > 0 || (input.remove?.length ?? 0) > 0));
}

function resolveLabelDeltas(
  metadata: TeamMetadata,
  currentLabels: { id: string; name: string }[],
  deltas: UpdateIssueInput["labelDeltas"],
): string[] | undefined {
  if (!hasLabelDeltas(deltas)) return undefined;

  const byName = new Map(
    currentLabels.map((label) => [label.name.toLowerCase(), { id: label.id, name: label.name }]),
  );

  for (const rawName of deltas?.remove ?? []) {
    const id = resolveLabelId(metadata, rawName);
    const canonical = metadata.labels.find((label) => label.id === id)?.name ?? rawName;
    byName.delete(canonical.toLowerCase());
  }
  for (const rawName of deltas?.add ?? []) {
    const id = resolveLabelId(metadata, rawName);
    const canonical = metadata.labels.find((label) => label.id === id)?.name ?? rawName;
    byName.set(canonical.toLowerCase(), { id, name: canonical });
  }

  return [...byName.values()].map((label) => label.id);
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
    // Wave-4 round-B: identifier → UUID via the lib's raw `ResolveIssueId`
    // query (same path updateIssue uses). The SDK-typed `c.issue()` requested
    // a 60+ field fragment that's expensive on the wire and brittle to mock;
    // the raw query asks only for `{id, identifier}` and consolidates the
    // lib on one resolution path.
    const issue = await resolveIssueIdByIdentifier(identifier);
    if (!issue) return { identifier, status: "not-found" };
    const client = await linear();
    const response = (await client.client.rawRequest(mutation, { id: issue.id })) as {
      data: { issueArchive?: { success: boolean }; issueUnarchive?: { success: boolean } };
    };
    const payload = response.data.issueArchive ?? response.data.issueUnarchive;
    if (!payload) {
      throw new ValidationError(
        `${_verb} issue mutation did not return a payload`,
        "retry after checking Linear state",
      );
    }
    requireMutationSuccess(_verb === "archive" ? "issueArchive" : "issueUnarchive", payload);
    return { identifier, status: "ok" };
  } catch (err) {
    // Prefer the structured boundary signal: the SDK wrapper maps "Entity
    // not found" to NotFoundError before it gets here. Fall back to the
    // legacy `rewriteNotFound` shape for any path that bypasses the wrapper
    // (e.g. raw fetch errors in tests).
    if (err instanceof NotFoundError) {
      return { identifier, status: "not-found" };
    }
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
  // Round-8 / H1: returns `null` on missing/unknown identifier, aligning
  // with every other `get_*` lib function (round-5's `tryMapToNull`
  // contract). Pre-round-8 this function threw `ValidationError("not
  // found: <id>")` via `rewriteNotFound` — that exception was carved out
  // for CLI affordance, but it created an 8-tools-vs-1-tool inconsistency
  // on the MCP surface. Round-8 closes the carve-out; CLI commands
  // (`show.ts`, `pull.ts`) now handle the null return with the same
  // user-facing error they printed before.
  //
  // Identifier shapes accepted: TEAM-NN (uppercased) AND UUIDs (passed
  // through; UUID branch added in CLI 17 round-6). Linear's GraphQL
  // `issue(id:)` resolver accepts both.
  const idLooksUuid = isUuid(identifier);
  const upperId = idLooksUuid ? identifier : identifier.toUpperCase();
  const query = buildPullIssuesQuery([upperId], false);
  return tryMapToNull(async () => {
    const response = (await withClient((c) => c.client.rawRequest(query))) as {
      data: Record<string, FetchedIssue | null>;
    };
    return response.data.a0 ?? null;
  });
}

export type { FetchedIssue, FetchedProject };
