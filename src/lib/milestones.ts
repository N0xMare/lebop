/**
 * Project milestone CRUD. Linear's `ProjectMilestone` is per-project — each
 * milestone belongs to exactly one project. Resolution: callers can pass
 * either a project name or UUID; helpers convert as needed.
 */

import { paginateRaw } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedMilestone {
  id: string;
  name: string;
  description: string | null;
  target_date: string | null;
  sort_order: number;
  project: { id: string; name: string };
}

const LIST_MILESTONES_QUERY = /* GraphQL */ `
  query ListMilestones($filter: ProjectMilestoneFilter, $first: Int!, $after: String) {
    projectMilestones(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        name
        description
        targetDate
        sortOrder
        project { id name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface MilestonesPageRaw {
  data: {
    projectMilestones: {
      nodes: {
        id: string;
        name: string;
        description: string | null;
        targetDate: string | null;
        sortOrder: number;
        project: { id: string; name: string };
      }[];
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
}): Promise<ListedMilestone[]> {
  const filter: Record<string, unknown> = {};
  if (opts.projectId) filter.project = { id: { eq: opts.projectId } };
  else if (opts.project) filter.project = { name: { eq: opts.project } };

  const client = await linear();
  const raw = await paginateRaw<
    MilestonesPageRaw["data"]["projectMilestones"]["nodes"][number],
    MilestonesPageRaw
  >(
    ({ first, after }) =>
      client.client.rawRequest(LIST_MILESTONES_QUERY, {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first,
        after,
      }) as Promise<MilestonesPageRaw>,
    (response) => response.data.projectMilestones,
    { pageSize: 250 },
  );
  // Linear's field naming is camelCase; lebop emits snake_case for stable
  // JSON output.
  return raw.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    target_date: m.targetDate,
    sort_order: m.sortOrder,
    project: m.project,
  }));
}

const GET_MILESTONE_QUERY = /* GraphQL */ `
  query GetMilestone($id: String!) {
    projectMilestone(id: $id) {
      id
      name
      description
      targetDate
      sortOrder
      project { id name }
    }
  }
`;

export async function getMilestone(id: string): Promise<ListedMilestone | null> {
  const response = (await withClient((c) => c.client.rawRequest(GET_MILESTONE_QUERY, { id }))) as {
    data: {
      projectMilestone: {
        id: string;
        name: string;
        description: string | null;
        targetDate: string | null;
        sortOrder: number;
        project: { id: string; name: string };
      } | null;
    };
  };
  const m = response.data.projectMilestone;
  if (!m) return null;
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    target_date: m.targetDate,
    sort_order: m.sortOrder,
    project: m.project,
  };
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
        id name description targetDate sortOrder
        project { id name }
      }
    }
  }
`;

export async function createMilestone(input: CreateMilestoneInput): Promise<ListedMilestone> {
  // NOT retry-wrapped — non-idempotent.
  const client = await linear();
  const response = (await client.client.rawRequest(CREATE_MILESTONE_MUTATION, { input })) as {
    data: {
      projectMilestoneCreate: {
        success: boolean;
        projectMilestone: {
          id: string;
          name: string;
          description: string | null;
          targetDate: string | null;
          sortOrder: number;
          project: { id: string; name: string };
        };
      };
    };
  };
  const m = response.data.projectMilestoneCreate.projectMilestone;
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    target_date: m.targetDate,
    sort_order: m.sortOrder,
    project: m.project,
  };
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
        id name description targetDate sortOrder
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
  const response = (await withClient((c) =>
    c.client.rawRequest(UPDATE_MILESTONE_MUTATION, { id, input }),
  )) as {
    data: {
      projectMilestoneUpdate: {
        success: boolean;
        projectMilestone: {
          id: string;
          name: string;
          description: string | null;
          targetDate: string | null;
          sortOrder: number;
          project: { id: string; name: string };
        };
      };
    };
  };
  const m = response.data.projectMilestoneUpdate.projectMilestone;
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    target_date: m.targetDate,
    sort_order: m.sortOrder,
    project: m.project,
  };
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
  return response.data.projectMilestoneDelete.success;
}

/**
 * Resolve a project name or UUID to a UUID. Used by milestone create when the
 * user passes `--project NAME`. Searches `team.projects` if `team` given,
 * otherwise tries the workspace-wide `projects` connection.
 */
export async function resolveProjectId(nameOrId: string): Promise<string | null> {
  // UUID shape — return as-is.
  if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;

  const PROJECTS_QUERY = /* GraphQL */ `
    query ResolveProject($name: String!) {
      projects(filter: { name: { eq: $name } }, first: 1) {
        nodes { id name }
      }
    }
  `;
  const response = (await withClient((c) =>
    c.client.rawRequest(PROJECTS_QUERY, { name: nameOrId }),
  )) as { data: { projects: { nodes: { id: string; name: string }[] } } };
  return response.data.projects.nodes[0]?.id ?? null;
}
