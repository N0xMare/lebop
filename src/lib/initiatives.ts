/**
 * Initiatives — Linear's org-level planning unit. An initiative groups
 * projects + tracks a long-term goal. Each initiative has its own status
 * timeline (initiative-updates with health), similar to project updates.
 *
 * Linear surfaces initiatives via dedicated GraphQL types: `Initiative`,
 * `InitiativeUpdate`, `IssueLabel`/`Project` join via `initiative.projects`.
 */

import { paginateRaw } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

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

const GET_INITIATIVE_QUERY = /* GraphQL */ `
  query GetInitiative($id: String!) {
    initiative(id: $id) {
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
`;

export interface FullInitiative extends ListedInitiative {
  projects: { id: string; name: string; state: string }[];
}

export async function getInitiative(id: string): Promise<FullInitiative | null> {
  const response = (await withClient((c) => c.client.rawRequest(GET_INITIATIVE_QUERY, { id }))) as {
    data: {
      initiative:
        | (InitiativeNode & {
            projects: { nodes: { id: string; name: string; state: string }[] };
          })
        | null;
    };
  };
  const i = response.data.initiative;
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

export async function initiativeRemoveProject(input: {
  initiativeId: string;
  projectId: string;
}): Promise<boolean> {
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
    if (!conn) return false;
    const match = conn.nodes.find((n) => n.initiative.id === input.initiativeId);
    if (match) {
      edgeId = match.id;
      break;
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  if (!edgeId) return false; // already absent

  const response = (await client.client.rawRequest(REMOVE_PROJECT_MUTATION, { id: edgeId })) as {
    data: { initiativeToProjectDelete: { success: boolean } };
  };
  return response.data.initiativeToProjectDelete.success;
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
// `initiativeUpdates` in 2026. The arg type for `Query.initiative(id)` is
// `String!`, not `ID!`.
const LIST_INITIATIVE_UPDATES_QUERY = /* GraphQL */ `
  query ListInitiativeUpdates($initiativeId: String!, $first: Int!, $after: String) {
    initiative(id: $initiativeId) {
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
    initiative: {
      initiativeUpdates: {
        nodes: InitiativeUpdateNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
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
    (response) => response.data.initiative?.initiativeUpdates ?? null,
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
  if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
  const RESOLVE = /* GraphQL */ `
    query ResolveInitiative($name: String!) {
      initiatives(filter: { name: { eq: $name } }, first: 1) {
        nodes { id name }
      }
    }
  `;
  const response = (await withClient((c) => c.client.rawRequest(RESOLVE, { name: nameOrId }))) as {
    data: { initiatives: { nodes: { id: string }[] } };
  };
  return response.data.initiatives.nodes[0]?.id ?? null;
}
