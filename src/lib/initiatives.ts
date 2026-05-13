/**
 * Initiatives — Linear's org-level planning unit. An initiative groups
 * projects + tracks a long-term goal. Each initiative has its own status
 * timeline (initiative-updates with health), similar to project updates.
 *
 * Linear surfaces initiatives via dedicated GraphQL types: `Initiative`,
 * `InitiativeUpdate`, `IssueLabel`/`Project` join via `initiative.projects`.
 */

import { LebopError, mapSdkError, NotFoundError, tryMapToNull, ValidationError } from "./errors.ts";
import { paginateRaw } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";
import { isUuid } from "./uuid.ts";

/**
 * Linear's `icon` field is an internal name (PascalCase, e.g. "BarChart" or
 * "Rocket"). Passing a Unicode emoji silently round-trips as a non-functional
 * string; reject those up-front with a structured ValidationError so callers
 * get an actionable message instead of an opaque server-side rejection.
 *
 * Uses `\p{Extended_Pictographic}` (Unicode 9+) which covers emoji, dingbats,
 * symbols, and the bulk of icon-shaped pictographic codepoints.
 */
function assertIconNotEmoji(icon: string | undefined, field = "icon"): void {
  if (icon === undefined) return;
  if (/^\p{Extended_Pictographic}/u.test(icon)) {
    throw new ValidationError(
      `${field} "${icon}" looks like an emoji — Linear expects an internal icon name (PascalCase)`,
      "use a name like 'BarChart', 'Rocket', 'Target'. Omit if unsure.",
    );
  }
}

export type InitiativeHealth = "onTrack" | "atRisk" | "offTrack";

export interface ListedInitiative {
  id: string;
  name: string;
  description: string | null;
  status: string | null;
  color: string | null;
  icon: string | null;
  url: string;
  target_date: string | null;
  archived_at: string | null;
  owner: { id: string; name: string; email: string } | null;
}

const LIST_INITIATIVES_QUERY = /* GraphQL */ `
  query ListInitiatives($filter: InitiativeFilter, $first: Int!, $after: String, $includeArchived: Boolean) {
    initiatives(filter: $filter, first: $first, after: $after, includeArchived: $includeArchived) {
      nodes {
        id
        name
        description
        status
        color
        icon
        url
        targetDate
        archivedAt
        owner { id name email }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface InitiativeNode {
  id: string;
  name: string;
  description: string | null;
  status: string | null;
  color: string | null;
  icon: string | null;
  url: string;
  targetDate: string | null;
  archivedAt: string | null;
  owner: { id: string; name: string; email: string } | null;
}

interface InitiativesPage {
  data: {
    initiatives: {
      nodes: InitiativeNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

function shapeInitiative(n: InitiativeNode): ListedInitiative {
  return {
    id: n.id,
    name: n.name,
    description: n.description,
    status: n.status,
    color: n.color,
    icon: n.icon,
    url: n.url,
    target_date: n.targetDate,
    archived_at: n.archivedAt,
    owner: n.owner,
  };
}

export interface ListInitiativesOpts {
  status?: string;
  ownerId?: string;
  includeArchived?: boolean;
  max?: number;
}

export async function listInitiatives(opts: ListInitiativesOpts = {}): Promise<ListedInitiative[]> {
  const filter: Record<string, unknown> = {};
  if (opts.status) filter.status = { eq: opts.status };
  if (opts.ownerId) filter.owner = { id: { eq: opts.ownerId } };

  const client = await linear();
  const raw = await paginateRaw<InitiativeNode, InitiativesPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_INITIATIVES_QUERY, {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first,
        after,
        includeArchived: opts.includeArchived ?? false,
      }) as Promise<InitiativesPage>,
    (response) => response.data.initiatives,
    { pageSize: 250, max: opts.max },
  );
  return raw.map(shapeInitiative);
}

// Uses the list-shape query (with includeArchived: true) rather than the
// single-record `initiative(id:)` getter. The latter throws "Entity not
// found" for ARCHIVED initiatives (Linear hides archived entities from
// single-record reads), which would silently return null here for
// initiatives that genuinely exist but are archived. Same trap caught
// `isInitiativeArchived` upstream; this is the same fix in a sibling
// code path. Variable typed ID! (not String!) per Linear's schema.
const GET_INITIATIVE_QUERY = /* GraphQL */ `
  query GetInitiative($id: ID!) {
    initiatives(filter: { id: { eq: $id } }, includeArchived: true, first: 1) {
      nodes {
        id
        name
        description
        status
        color
        icon
        url
        targetDate
        archivedAt
        owner { id name email }
        projects(first: 250) {
          nodes { id name state }
        }
      }
    }
  }
`;

export interface FullInitiative extends ListedInitiative {
  projects: { id: string; name: string; state: string }[];
}

export async function getInitiative(id: string): Promise<FullInitiative | null> {
  // List-shape query with includeArchived: true correctly surfaces both
  // live AND archived initiatives. Null result means "no initiative with
  // this id exists at all" (the stable "missing → null" contract).
  type Resp = {
    data: {
      initiatives: {
        nodes: Array<
          InitiativeNode & {
            projects: { nodes: { id: string; name: string; state: string }[] };
          }
        >;
      };
    };
  };
  const response = await tryMapToNull<Resp>(
    () => withClient((c) => c.client.rawRequest(GET_INITIATIVE_QUERY, { id })) as Promise<Resp>,
  );
  if (!response) return null;
  const i = response.data.initiatives.nodes[0];
  if (!i) return null;
  return { ...shapeInitiative(i), projects: i.projects.nodes };
}

export interface CreateInitiativeInput {
  name: string;
  description?: string;
  status?: string;
  ownerId?: string;
  targetDate?: string;
  color?: string;
  icon?: string;
}

const CREATE_INITIATIVE_MUTATION = /* GraphQL */ `
  mutation CreateInitiative($input: InitiativeCreateInput!) {
    initiativeCreate(input: $input) {
      success
      initiative {
        id name description status color icon url targetDate archivedAt
        owner { id name email }
      }
    }
  }
`;

export async function createInitiative(input: CreateInitiativeInput): Promise<ListedInitiative> {
  assertIconNotEmoji(input.icon);
  // NOT retry-wrapped — non-idempotent.
  const client = await linear();
  const response = (await client.client.rawRequest(CREATE_INITIATIVE_MUTATION, { input })) as {
    data: { initiativeCreate: { success: boolean; initiative: InitiativeNode } };
  };
  return shapeInitiative(response.data.initiativeCreate.initiative);
}

export interface UpdateInitiativeInput {
  name?: string;
  description?: string;
  status?: string;
  ownerId?: string | null;
  targetDate?: string | null;
  color?: string;
  icon?: string;
}

const UPDATE_INITIATIVE_MUTATION = /* GraphQL */ `
  mutation UpdateInitiative($id: String!, $input: InitiativeUpdateInput!) {
    initiativeUpdate(id: $id, input: $input) {
      success
      initiative {
        id name description status color icon url targetDate archivedAt
        owner { id name email }
      }
    }
  }
`;

export async function updateInitiative(
  id: string,
  input: UpdateInitiativeInput,
): Promise<ListedInitiative> {
  assertIconNotEmoji(input.icon);
  // Idempotent — retry-wrapped.
  const response = (await withClient((c) =>
    c.client.rawRequest(UPDATE_INITIATIVE_MUTATION, { id, input }),
  )) as {
    data: { initiativeUpdate: { success: boolean; initiative: InitiativeNode } };
  };
  return shapeInitiative(response.data.initiativeUpdate.initiative);
}

const ARCHIVE_INITIATIVE_MUTATION = /* GraphQL */ `
  mutation ArchiveInitiative($id: String!) {
    initiativeArchive(id: $id) { success }
  }
`;

export async function archiveInitiative(id: string): Promise<boolean> {
  // NOT wrapped — re-running would surface as not-found-or-already-archived.
  const client = await linear();
  const response = (await client.client.rawRequest(ARCHIVE_INITIATIVE_MUTATION, { id })) as {
    data: { initiativeArchive: { success: boolean } };
  };
  return response.data.initiativeArchive.success;
}

const UNARCHIVE_INITIATIVE_MUTATION = /* GraphQL */ `
  mutation UnarchiveInitiative($id: String!) {
    initiativeUnarchive(id: $id) { success }
  }
`;

export async function unarchiveInitiative(id: string): Promise<boolean> {
  const client = await linear();
  const response = (await client.client.rawRequest(UNARCHIVE_INITIATIVE_MUTATION, { id })) as {
    data: { initiativeUnarchive: { success: boolean } };
  };
  return response.data.initiativeUnarchive.success;
}

const DELETE_INITIATIVE_MUTATION = /* GraphQL */ `
  mutation DeleteInitiative($id: String!) {
    initiativeDelete(id: $id) { success }
  }
`;

export async function deleteInitiative(id: string): Promise<boolean> {
  // Round-7 / Q2 (refined): Linear's `initiativeDelete` is a SOFT delete —
  // sets `archivedAt` on the initiative; the delete mutation itself
  // returns `success: true` on any id. Pre-flight + archived_at check
  // ensures `tryIdempotentDelete` emits `{status: "already-absent"}` on
  // re-runs (matching the noisy delete sibling APIs).
  const existing = await getInitiative(id);
  if (!existing || existing.archived_at !== null) {
    throw new NotFoundError(
      `initiative not found: ${id}`,
      "the initiative may have already been deleted",
    );
  }
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_INITIATIVE_MUTATION, { id })) as {
    data: { initiativeDelete: { success: boolean } };
  };
  return response.data.initiativeDelete.success;
}

// ---------- initiative ↔ project edges ----------

const ADD_PROJECT_MUTATION = /* GraphQL */ `
  mutation InitiativeAddProject($input: InitiativeToProjectCreateInput!) {
    initiativeToProjectCreate(input: $input) {
      success
      initiativeToProject { id }
    }
  }
`;

export async function initiativeAddProject(input: {
  initiativeId: string;
  projectId: string;
  sortOrder?: number;
}): Promise<{ id: string }> {
  // Server-side idempotent at the (initiativeId, projectId) tuple — safe to retry.
  const response = (await withClient((c) =>
    c.client.rawRequest(ADD_PROJECT_MUTATION, { input }),
  )) as {
    data: {
      initiativeToProjectCreate: { success: boolean; initiativeToProject: { id: string } };
    };
  };
  return { id: response.data.initiativeToProjectCreate.initiativeToProject.id };
}

// Linear removed the `filter` arg on `Query.initiativeToProjects` in 2026,
// so the join record can no longer be looked up server-side by (initiative,
// project) tuple. We walk `Project.initiativeToProjects` (typically only a
// few entries per project) and match the initiative id client-side.
const FIND_PROJECT_INITIATIVE_LINKS_QUERY = /* GraphQL */ `
  query FindProjectInitiativeLinks($projectId: String!, $first: Int!, $after: String) {
    project(id: $projectId) {
      initiativeToProjects(first: $first, after: $after) {
        nodes {
          id
          initiative { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const REMOVE_PROJECT_MUTATION = /* GraphQL */ `
  mutation InitiativeRemoveProject($id: String!) {
    initiativeToProjectDelete(id: $id) { success }
  }
`;

// Archive-state probe used when an initiative's edges look absent. Uses
// `initiatives(filter:..., includeArchived: true)` rather than the
// single-record `initiative(id:)` getter — the latter throws
// "Entity not found" for archived initiatives (Linear hides them from
// single-record reads), which would defeat the entire point of the probe.
// The list query DOES surface archived initiatives when `includeArchived`
// is true. Variable typed as ID! (not String!) per Linear's schema.
const INITIATIVE_ARCHIVED_PROBE_QUERY = /* GraphQL */ `
  query InitiativeArchivedProbe($id: ID!) {
    initiatives(filter: { id: { eq: $id } }, includeArchived: true) {
      nodes { id archivedAt }
    }
  }
`;

interface ProjectInitiativeLinksPage {
  data: {
    project: {
      initiativeToProjects: {
        nodes: { id: string; initiative: { id: string } }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  };
}

/**
 * Structured result for `initiativeRemoveProject`. The boolean `removed`
 * answers "did we actually delete a link?"; `reason` disambiguates the falsy
 * cases (link absent, initiative archived, server-side rejection).
 *
 * Why not just throw? Linear's `initiativeToProjectDelete` returns
 * `success: false` for several distinct user-recoverable conditions (the
 * link wasn't there to begin with; the initiative is archived and refuses
 * mutations; some other server-side refusal). Collapsing all of those into
 * a bare `false` is the bug this shape fixes — agents need to disambiguate.
 */
export interface InitiativeRemoveProjectResult {
  removed: boolean;
  reason?: "absent" | "archived" | "other";
  message?: string;
}

/**
 * Probe whether an initiative is currently archived. Used to disambiguate
 * three failure modes that all look like "edge not found" on the surface:
 *
 *   1. Genuine concurrent removal (another caller deleted the edge first)
 *   2. The user's identifier is bogus / wrong project / wrong initiative
 *   3. **The initiative is archived** — Linear hides every edge from
 *      `Project.initiativeToProjects` and returns "Entity not found" on
 *      `initiativeToProjectDelete(edgeId)`. The user's input is correct;
 *      the operation can't proceed until they `unarchive_initiative`.
 *
 * Live probe (2026-05-12) confirmed Linear NEVER returns an "archived"
 * error message for this operation — the edge is silently invisible. So
 * we MUST probe to classify (1)+(2) vs (3); message-text matching would
 * never distinguish them.
 *
 * Probe failures (network, auth, etc.) return `false` — never mask the
 * original outcome with a probe error.
 */
async function isInitiativeArchived(id: string): Promise<boolean> {
  try {
    const response = (await withClient((c) =>
      c.client.rawRequest(INITIATIVE_ARCHIVED_PROBE_QUERY, { id }),
    )) as {
      data: { initiatives: { nodes: Array<{ id: string; archivedAt: string | null }> } };
    };
    const node = response.data.initiatives.nodes[0];
    return node?.archivedAt != null;
  } catch {
    // Probe is advisory — never let it mask the original outcome.
    return false;
  }
}

/**
 * Higher-order probe-then-classify helper. Probes the initiative's archive
 * state; if archived returns the canonical archived result; otherwise calls
 * `notArchivedResult()` to build whatever the context-specific fallback is
 * (typically `reason: "absent"` for no-edge paths or `reason: "other"` for
 * post-mutation refusals).
 */
async function probeArchiveOr(
  initiativeId: string,
  notArchivedResult: () => InitiativeRemoveProjectResult,
): Promise<InitiativeRemoveProjectResult> {
  const archived = await isInitiativeArchived(initiativeId);
  if (archived) {
    return {
      removed: false,
      reason: "archived",
      message: `initiative ${initiativeId} is archived; unarchive it before removing project links`,
    };
  }
  return notArchivedResult();
}

/**
 * Build the "absent vs archived" structured result for the case where no
 * edge is visible. Runs the archive probe once and returns the appropriate
 * `reason` + actionable message. Thin wrapper around `probeArchiveOr`.
 */
async function absentOrArchived(
  initiativeId: string,
  absentMessage: string,
): Promise<InitiativeRemoveProjectResult> {
  return probeArchiveOr(initiativeId, () => ({
    removed: false,
    reason: "absent",
    message: absentMessage,
  }));
}

export async function initiativeRemoveProject(input: {
  initiativeId: string;
  projectId: string;
}): Promise<InitiativeRemoveProjectResult> {
  // Walk the project's initiativeToProjects connection, looking for the
  // edge whose initiative.id matches. Stops as soon as we find it.
  const client = await linear();
  let after: string | null = null;
  let edgeId: string | null = null;
  while (true) {
    const response = (await client.client.rawRequest(FIND_PROJECT_INITIATIVE_LINKS_QUERY, {
      projectId: input.projectId,
      first: 250,
      after,
    })) as ProjectInitiativeLinksPage;
    const conn = response.data.project?.initiativeToProjects;
    if (!conn) {
      // Project itself wasn't found — disambiguate: was the initiative
      // archived (Linear hides the edge for archived initiatives) or is
      // the project genuinely missing? Probe to classify.
      return absentOrArchived(
        input.initiativeId,
        `project ${input.projectId} has no initiative link to ${input.initiativeId}`,
      );
    }
    const match = conn.nodes.find((n) => n.initiative.id === input.initiativeId);
    if (match) {
      edgeId = match.id;
      break;
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  if (!edgeId) {
    // Walk finished without finding the edge. Three cases collapsed into
    // one observation; probe to classify archived vs truly-absent.
    return absentOrArchived(
      input.initiativeId,
      `project ${input.projectId} is not linked to initiative ${input.initiativeId}`,
    );
  }

  // Edge found. Attempt the delete.
  try {
    const response = (await client.client.rawRequest(REMOVE_PROJECT_MUTATION, {
      id: edgeId,
    })) as {
      data: { initiativeToProjectDelete: { success: boolean } };
    };
    if (response.data.initiativeToProjectDelete.success) {
      return { removed: true };
    }
    // success: false — Linear refused without throwing. Probe archive
    // state to classify (race: initiative archived between our walk and
    // the mutation). Falls through to `reason: "other"` if not archived
    // since the edge existed at walk time, so it's not "absent".
    return probeArchiveOr(input.initiativeId, () => ({
      removed: false,
      reason: "other",
      message: "Linear refused the removal (initiativeToProjectDelete returned success: false)",
    }));
  } catch (err) {
    const mapped = err instanceof LebopError ? err : mapSdkError(err);
    // NotFound on the edge id: either (a) a concurrent removal got there
    // first, OR (b) the initiative was archived between our walk and the
    // mutation. Probe to disambiguate — same logic as the no-edge branch
    // above.
    if (mapped instanceof NotFoundError) {
      return absentOrArchived(
        input.initiativeId,
        `edge ${edgeId} was already deleted (concurrent removal)`,
      );
    }
    throw mapped;
  }
}

// ---------- initiative-update (status posts with health) ----------

export interface ListedInitiativeUpdate {
  id: string;
  body: string;
  health: InitiativeHealth | null;
  created_at: string;
  user: { id: string; name: string; email: string } | null;
}

// Linear renamed the connection on Initiative from `updates` to
// `initiativeUpdates` in 2026. We use the list-shape `initiatives(filter,
// includeArchived: true)` query rather than the single-record
// `initiative(id:)` getter for the same reason as `getInitiative` —
// `initiative(id:)` throws NOT_FOUND for archived initiatives, so updates
// on an archived initiative would surface as a `NotFoundError` thrown
// from page 1 of the paginated walk. The list-shape query handles
// archived initiatives transparently. Variable typed ID! (not String!).
const LIST_INITIATIVE_UPDATES_QUERY = /* GraphQL */ `
  query ListInitiativeUpdates($initiativeId: ID!, $first: Int!, $after: String) {
    initiatives(filter: { id: { eq: $initiativeId } }, includeArchived: true, first: 1) {
      nodes {
        initiativeUpdates(first: $first, after: $after) {
          nodes {
            id
            body
            health
            createdAt
            user { id name email }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

interface InitiativeUpdateNode {
  id: string;
  body: string;
  health: InitiativeHealth | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

interface InitiativeUpdatesPage {
  data: {
    initiatives: {
      nodes: Array<{
        initiativeUpdates: {
          nodes: InitiativeUpdateNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>;
    };
  };
}

export async function listInitiativeUpdates(
  initiativeId: string,
): Promise<ListedInitiativeUpdate[]> {
  const client = await linear();
  const raw = await paginateRaw<InitiativeUpdateNode, InitiativeUpdatesPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_INITIATIVE_UPDATES_QUERY, {
        initiativeId,
        first,
        after,
      }) as Promise<InitiativeUpdatesPage>,
    (response) => response.data.initiatives.nodes[0]?.initiativeUpdates ?? null,
    { pageSize: 250 },
  );
  return raw.map((u) => ({
    id: u.id,
    body: u.body,
    health: u.health,
    created_at: u.createdAt,
    user: u.user,
  }));
}

export interface CreateInitiativeUpdateInput {
  initiativeId: string;
  body: string;
  health?: InitiativeHealth;
}

const CREATE_INITIATIVE_UPDATE_MUTATION = /* GraphQL */ `
  mutation CreateInitiativeUpdate($input: InitiativeUpdateCreateInput!) {
    initiativeUpdateCreate(input: $input) {
      success
      initiativeUpdate {
        id body health createdAt
        user { id name email }
      }
    }
  }
`;

export async function createInitiativeUpdate(
  input: CreateInitiativeUpdateInput,
): Promise<ListedInitiativeUpdate> {
  // NOT retry-wrapped — would post a duplicate.
  const client = await linear();
  const response = (await client.client.rawRequest(CREATE_INITIATIVE_UPDATE_MUTATION, {
    input,
  })) as {
    data: {
      initiativeUpdateCreate: {
        success: boolean;
        initiativeUpdate: InitiativeUpdateNode;
      };
    };
  };
  const u = response.data.initiativeUpdateCreate.initiativeUpdate;
  return {
    id: u.id,
    body: u.body,
    health: u.health,
    created_at: u.createdAt,
    user: u.user,
  };
}

/**
 * Resolve an initiative name or UUID to a UUID. Unlike projects, initiative
 * filtering by name uses `name: { eq }`.
 */
export async function resolveInitiativeId(nameOrId: string): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  // includeArchived: true so name lookup works for unarchive/delete on
  // already-archived initiatives. Linear treats archived as soft-deleted
  // and excludes them from default queries; without this, the smoke
  // `unarchive_initiative {id: "<name>"}` cannot find its target.
  const RESOLVE = /* GraphQL */ `
    query ResolveInitiative($name: String!) {
      initiatives(filter: { name: { eq: $name } }, first: 1, includeArchived: true) {
        nodes { id name }
      }
    }
  `;
  const response = (await withClient((c) => c.client.rawRequest(RESOLVE, { name: nameOrId }))) as {
    data: { initiatives: { nodes: { id: string }[] } };
  };
  return response.data.initiatives.nodes[0]?.id ?? null;
}
