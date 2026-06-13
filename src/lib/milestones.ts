/**
 * Project milestone CRUD. Linear's `ProjectMilestone` is per-project — each
 * milestone belongs to exactly one project. Resolution: callers can pass
 * either a project name or UUID; helpers convert as needed.
 */

import { tryMapToNull } from "./errors.ts";
import { requireMutationEntity, requireMutationSuccess } from "./mutationResult.ts";
import { type ConnectionPage, paginateRaw, paginateRawPage } from "./paginate.ts";
import { getProject } from "./projects.ts";
import { ResolveError, resolveProjectIdByName } from "./resolve.ts";
import { linear, withClient } from "./sdk.ts";
import { isUuid } from "./uuid.ts";

export interface ListedMilestone {
  id: string;
  name: string;
  description: string | null;
  target_date: string | null;
  sort_order: number;
  archived_at: string | null;
  project: { id: string; name: string };
}

// Round-7 / HIGH-2: opt-in `includeArchived` matches the description in
// the MCP tool — pre-round-7 the description claimed cascade-archived
// milestones surface but the query didn't actually pass the flag. Default
// stays false (live-only) for backwards compat; callers pass true to
// surface archived rows + the `archived_at` field per row.
const LIST_MILESTONES_QUERY = /* GraphQL */ `
  query ListMilestones($filter: ProjectMilestoneFilter, $first: Int!, $after: String, $includeArchived: Boolean) {
    projectMilestones(filter: $filter, first: $first, after: $after, includeArchived: $includeArchived) {
      nodes {
        id
        name
        description
        targetDate
        sortOrder
        archivedAt
        project { id name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Round-6 / M5: factor the inline literal that was duplicated 4× across
// list/get/create/update into a single node interface + shape() helper —
// mirrors the pattern in src/lib/documents.ts and src/lib/initiatives.ts.
// Adding the next field (e.g. createdAt) is now one edit instead of four.
interface MilestoneNode {
  id: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  sortOrder: number;
  archivedAt: string | null;
  project: { id: string; name: string };
}

function shapeMilestone(m: MilestoneNode): ListedMilestone {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    target_date: m.targetDate,
    sort_order: m.sortOrder,
    archived_at: m.archivedAt,
    project: m.project,
  };
}

// Round-8 / R7-L4: reuse `MilestoneNode` instead of duplicating the inline
// shape (closes the M5 dedup loop — was the last remaining duplicate).
interface MilestonesPageRaw {
  data: {
    projectMilestones: {
      nodes: MilestoneNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

/**
 * List milestones. Filter by project (UUID or name); omit to list all
 * milestones the token can see across the workspace.
 */
export async function listMilestones(opts: {
  projectId?: string;
  project?: string;
  search?: string;
  /** Round-7 / HIGH-2: surface cascade-archived rows alongside live ones. */
  includeArchived?: boolean;
  max?: number;
}): Promise<ListedMilestone[]> {
  const filter = buildMilestoneFilter(opts);
  const client = await linear();
  const raw = await paginateRaw<
    MilestonesPageRaw["data"]["projectMilestones"]["nodes"][number],
    MilestonesPageRaw
  >(
    ({ first, after }) =>
      client.client.rawRequest(LIST_MILESTONES_QUERY, {
        filter,
        first,
        after,
        includeArchived: Boolean(opts.includeArchived),
      }) as Promise<MilestonesPageRaw>,
    (response) => response.data.projectMilestones,
    { pageSize: 250, max: opts.max },
  );
  return raw.map(shapeMilestone);
}

export async function listMilestonesPage(opts: {
  projectId?: string;
  project?: string;
  search?: string;
  includeArchived?: boolean;
  limit: number;
  after?: string;
}): Promise<ConnectionPage<ListedMilestone>> {
  const filter = buildMilestoneFilter(opts);
  const client = await linear();
  const page = await paginateRawPage<
    MilestonesPageRaw["data"]["projectMilestones"]["nodes"][number],
    MilestonesPageRaw
  >(
    ({ first, after }) =>
      client.client.rawRequest(LIST_MILESTONES_QUERY, {
        filter,
        first,
        after,
        includeArchived: Boolean(opts.includeArchived),
      }) as Promise<MilestonesPageRaw>,
    (response) => response.data.projectMilestones,
    { limit: opts.limit, after: opts.after, pageSize: 250 },
  );
  return { nodes: page.nodes.map(shapeMilestone), pageInfo: page.pageInfo };
}

function buildMilestoneFilter(opts: {
  projectId?: string;
  project?: string;
  search?: string;
}): Record<string, unknown> | undefined {
  const filter: Record<string, unknown> = {};
  if (opts.projectId) filter.project = { id: { eq: opts.projectId } };
  else if (opts.project) filter.project = { name: { eq: opts.project } };
  if (opts.search) filter.name = { containsIgnoreCase: opts.search };
  return Object.keys(filter).length > 0 ? filter : undefined;
}

// Uses the list-shape query (with includeArchived: true) rather than the
// single-record `projectMilestone(id:)` getter. Live-probed 2026-05-12:
// `projectMilestone(id:)` hides archived rows (same archive-bug pattern
// caught for `initiative(id:)` in round 4 + `getInitiative`/
// `listInitiativeUpdates` in round 4-followup). Note: Linear has no
// user-facing `projectMilestoneArchive` mutation — milestones either
// stay live or cascade-archive when their parent project is archived;
// the bug surfaces in that cascade case. `first: 1` bounds the outer
// pagination since the ID filter guarantees at-most-one result (also
// keeps complexity within Linear's per-query budget).
const GET_MILESTONE_QUERY = /* GraphQL */ `
  query GetMilestone($id: ID!) {
    projectMilestones(filter: { id: { eq: $id } }, includeArchived: true, first: 1) {
      nodes {
        id
        name
        description
        targetDate
        sortOrder
        archivedAt
        project { id name }
      }
    }
  }
`;

const GET_MILESTONE_DIRECT_QUERY = /* GraphQL */ `
  query GetMilestoneDirect($id: String!) {
    projectMilestone(id: $id) {
      id
      name
      description
      targetDate
      sortOrder
      archivedAt
      project { id name }
    }
  }
`;

export async function getMilestone(id: string): Promise<ListedMilestone | null> {
  // Round-10 / M-7-smoke: pre-check UUID format so non-UUID input returns
  // null at the lib boundary instead of hitting Linear's `ID!` scalar and
  // surfacing as `validation_error`. The parity goal is observable at the
  // *MCP tool* boundary: `get_initiative {id: "not-a-uuid"}` returns null
  // because the MCP handler calls `resolveInitiativeId` first (which
  // regex-checks for UUID, then falls through to name lookup → returns
  // null on miss). The lib `getInitiative` itself does NOT pre-check; it
  // leans on `tryMapToNull`'s M-7 widening to swallow Linear's
  // "Argument Validation Error - …id…" response. Milestones have no
  // name-resolver (milestone names aren't unique workspace-wide), so a
  // boundary pre-check here is the cleanest way to land the same null
  // contract.
  //
  // Round-13 / N-1 caveat: `isUuid` uses the loose form `/^[0-9a-f-]{36}$/i`
  // shared via `src/lib/uuid.ts`. Inputs that satisfy the loose form but
  // aren't real UUIDs (e.g. 36 dashes, or all-hex-no-dashes) still hit
  // Linear and round-trip through `tryMapToNull`'s M-7 widening → null.
  // Net observable behavior is identical (any non-resolving input ends up
  // null), but the "no Linear round-trip" cost saving only applies to
  // morphologically-non-UUID inputs.
  if (!isUuid(id)) return null;
  // List-shape query with includeArchived: true correctly surfaces both
  // live AND archived milestones. Null result means "no milestone with
  // this id exists at all" (the stable "missing → null" contract).
  type Resp = {
    data: {
      projectMilestones: {
        nodes: Array<{
          id: string;
          name: string;
          description: string | null;
          targetDate: string | null;
          sortOrder: number;
          archivedAt: string | null;
          project: { id: string; name: string };
        }>;
      };
    };
  };
  const response = await tryMapToNull<Resp>(
    () => withClient((c) => c.client.rawRequest(GET_MILESTONE_QUERY, { id })) as Promise<Resp>,
  );
  if (!response) return null;
  const m = response.data.projectMilestones.nodes[0];
  if (m) return shapeMilestone(m);

  // Linear's list-shape filter is archive-resilient but can lag immediately
  // after creation. The direct getter sees fresh live rows, while still hiding
  // some cascade-archived rows; use it only as a fallback after the archived
  // query returned no nodes.
  type DirectResp = {
    data: {
      projectMilestone: {
        id: string;
        name: string;
        description: string | null;
        targetDate: string | null;
        sortOrder: number;
        archivedAt: string | null;
        project: { id: string; name: string };
      } | null;
    };
  };
  const direct = await tryMapToNull<DirectResp>(
    () =>
      withClient((c) =>
        c.client.rawRequest(GET_MILESTONE_DIRECT_QUERY, { id }),
      ) as Promise<DirectResp>,
  );
  const directMilestone = direct?.data.projectMilestone;
  return directMilestone ? shapeMilestone(directMilestone) : null;
}

export interface CreateMilestoneInput {
  name: string;
  /** Project UUID (resolve from name first if needed). */
  projectId: string;
  description?: string;
  targetDate?: string; // ISO date
  sortOrder?: number;
}

const CREATE_MILESTONE_MUTATION = /* GraphQL */ `
  mutation CreateMilestone($input: ProjectMilestoneCreateInput!) {
    projectMilestoneCreate(input: $input) {
      success
      projectMilestone {
        id name description targetDate sortOrder archivedAt
        project { id name }
      }
    }
  }
`;

export async function createMilestone(input: CreateMilestoneInput): Promise<ListedMilestone> {
  // NOT retry-wrapped — non-idempotent.
  const client = await linear();
  // Round-7 / MED-3: reuse `MilestoneNode` instead of duplicating the
  // inline shape (finishes the round-6 M5 dedup that left create/update
  // still inlined).
  const response = (await client.client.rawRequest(CREATE_MILESTONE_MUTATION, { input })) as {
    data: { projectMilestoneCreate: { success: boolean; projectMilestone: MilestoneNode } };
  };
  const milestone = requireMutationEntity<MilestoneNode>(
    "projectMilestoneCreate",
    response.data.projectMilestoneCreate,
    "projectMilestone",
  );
  return shapeMilestone(milestone);
}

export interface UpdateMilestoneInput {
  name?: string;
  description?: string;
  targetDate?: string | null;
  sortOrder?: number;
  projectId?: string; // move to a different project
}

const UPDATE_MILESTONE_MUTATION = /* GraphQL */ `
  mutation UpdateMilestone($id: String!, $input: ProjectMilestoneUpdateInput!) {
    projectMilestoneUpdate(id: $id, input: $input) {
      success
      projectMilestone {
        id name description targetDate sortOrder archivedAt
        project { id name }
      }
    }
  }
`;

export async function updateMilestone(
  id: string,
  input: UpdateMilestoneInput,
): Promise<ListedMilestone> {
  // Update at the value level is idempotent — same input → same outcome.
  // Round-7 / MED-3: reuse `MilestoneNode`.
  const response = (await withClient((c) =>
    c.client.rawRequest(UPDATE_MILESTONE_MUTATION, { id, input }),
  )) as {
    data: { projectMilestoneUpdate: { success: boolean; projectMilestone: MilestoneNode } };
  };
  const milestone = requireMutationEntity<MilestoneNode>(
    "projectMilestoneUpdate",
    response.data.projectMilestoneUpdate,
    "projectMilestone",
  );
  return shapeMilestone(milestone);
}

const DELETE_MILESTONE_MUTATION = /* GraphQL */ `
  mutation DeleteMilestone($id: String!) {
    projectMilestoneDelete(id: $id) { success }
  }
`;

export async function deleteMilestone(id: string): Promise<boolean> {
  // NOT wrapped — re-running after first success would surface as not-found.
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_MILESTONE_MUTATION, { id })) as {
    data: { projectMilestoneDelete: { success: boolean } };
  };
  requireMutationSuccess("projectMilestoneDelete", response.data.projectMilestoneDelete);
  return true;
}

/**
 * Resolve a project name or UUID to a UUID. Used by milestone create when the
 * user passes `--project NAME`. Searches `team.projects` if `team` given,
 * otherwise tries the workspace-wide `projects` connection.
 */
export async function resolveProjectId(nameOrId: string): Promise<string | null> {
  // UUID shape — return as-is.
  if (isUuid(nameOrId)) return nameOrId;
  try {
    return await resolveProjectIdByName(nameOrId);
  } catch (err) {
    if (err instanceof ResolveError && err.message.startsWith("project not found:")) return null;
    throw err;
  }
}

export async function resolveExistingProjectId(nameOrId: string): Promise<string | null> {
  if (!isUuid(nameOrId)) return resolveProjectId(nameOrId);
  const project = await getProject(nameOrId);
  return project ? nameOrId : null;
}
