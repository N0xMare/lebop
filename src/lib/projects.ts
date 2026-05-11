/**
 * Project CRUD + project-update (status updates with health) over Linear's
 * Project + ProjectUpdate surfaces. Used by `lebop project ...`,
 * `lebop project-update ...`, and the MCP equivalents.
 */

import { paginateConnection, paginateRaw } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedProject {
  id: string;
  name: string;
  description: string | null;
  state: string;
  url: string;
  updated_at: string;
}

export async function listProjects(opts: {
  team?: string;
  state?: string;
  max?: number;
}): Promise<ListedProject[]> {
  const client = await linear();
  // Push state filter to GraphQL so `max` counts post-filter results.
  // (`projects.state` is a String filter on the project's state name.)
  const filter: Record<string, unknown> | undefined = opts.state
    ? { state: { eq: opts.state } }
    : undefined;

  if (opts.team) {
    // Team-scoped: walk team.projects
    const teams = await withClient((c) => c.teams({ filter: { key: { eq: opts.team } } }));
    const team = teams.nodes[0];
    if (!team) throw new Error(`team not found: ${opts.team}`);
    const projects = await paginateConnection(
      ({ first, after }) => team.projects({ first, after, filter }),
      { max: opts.max },
    );
    return projects.map(shapeProject);
  }

  // Workspace-wide listing
  const projects = await paginateConnection(
    ({ first, after }) => client.projects({ first, after, filter }),
    { max: opts.max },
  );
  return projects.map(shapeProject);
}

function shapeProject(p: {
  id: string;
  name: string;
  description: string | null;
  state: string;
  url: string;
  updatedAt: Date;
}): ListedProject {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    state: p.state,
    url: p.url,
    updated_at: p.updatedAt.toISOString(),
  };
}

export interface FullProject {
  id: string;
  name: string;
  description: string | null;
  content: string | null;
  state: string;
  url: string;
  updated_at: string;
  start_date: string | null;
  target_date: string | null;
  teams: { id: string; key: string; name: string }[];
  lead: { id: string; name: string; email: string } | null;
}

const GET_PROJECT_QUERY = /* GraphQL */ `
  query GetProject($id: String!) {
    project(id: $id) {
      id
      name
      description
      content
      state
      url
      updatedAt
      startDate
      targetDate
      teams { nodes { id key name } }
      lead { id name email }
    }
  }
`;

export async function getProject(id: string): Promise<FullProject | null> {
  const response = (await withClient((c) => c.client.rawRequest(GET_PROJECT_QUERY, { id }))) as {
    data: {
      project: {
        id: string;
        name: string;
        description: string | null;
        content: string | null;
        state: string;
        url: string;
        updatedAt: string;
        startDate: string | null;
        targetDate: string | null;
        teams: { nodes: { id: string; key: string; name: string }[] };
        lead: { id: string; name: string; email: string } | null;
      } | null;
    };
  };
  const p = response.data.project;
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    content: p.content,
    state: p.state,
    url: p.url,
    updated_at: p.updatedAt,
    start_date: p.startDate,
    target_date: p.targetDate,
    teams: p.teams.nodes,
    lead: p.lead,
  };
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  content?: string;
  state?: string;
  /** Linear requires at least one team UUID. */
  teamIds: string[];
  startDate?: string;
  targetDate?: string;
}

const CREATE_PROJECT_MUTATION = /* GraphQL */ `
  mutation CreateProject($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project {
        id name description content state url updatedAt startDate targetDate
        teams { nodes { id key name } }
        lead { id name email }
      }
    }
  }
`;

export async function createProject(input: CreateProjectInput): Promise<FullProject> {
  // NOT retry-wrapped — non-idempotent.
  const client = await linear();
  const response = (await client.client.rawRequest(CREATE_PROJECT_MUTATION, { input })) as {
    data: {
      projectCreate: {
        success: boolean;
        project: {
          id: string;
          name: string;
          description: string | null;
          content: string | null;
          state: string;
          url: string;
          updatedAt: string;
          startDate: string | null;
          targetDate: string | null;
          teams: { nodes: { id: string; key: string; name: string }[] };
          lead: { id: string; name: string; email: string } | null;
        };
      };
    };
  };
  const p = response.data.projectCreate.project;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    content: p.content,
    state: p.state,
    url: p.url,
    updated_at: p.updatedAt,
    start_date: p.startDate,
    target_date: p.targetDate,
    teams: p.teams.nodes,
    lead: p.lead,
  };
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  content?: string;
  state?: string;
  startDate?: string | null;
  targetDate?: string | null;
}

const UPDATE_PROJECT_MUTATION = /* GraphQL */ `
  mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
      project {
        id name description content state url updatedAt startDate targetDate
        teams { nodes { id key name } }
        lead { id name email }
      }
    }
  }
`;

export async function updateProject(id: string, input: UpdateProjectInput): Promise<FullProject> {
  // Idempotent at the value level — retry-wrapped.
  const response = (await withClient((c) =>
    c.client.rawRequest(UPDATE_PROJECT_MUTATION, { id, input }),
  )) as {
    data: {
      projectUpdate: {
        success: boolean;
        project: {
          id: string;
          name: string;
          description: string | null;
          content: string | null;
          state: string;
          url: string;
          updatedAt: string;
          startDate: string | null;
          targetDate: string | null;
          teams: { nodes: { id: string; key: string; name: string }[] };
          lead: { id: string; name: string; email: string } | null;
        };
      };
    };
  };
  const p = response.data.projectUpdate.project;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    content: p.content,
    state: p.state,
    url: p.url,
    updated_at: p.updatedAt,
    start_date: p.startDate,
    target_date: p.targetDate,
    teams: p.teams.nodes,
    lead: p.lead,
  };
}

const DELETE_PROJECT_MUTATION = /* GraphQL */ `
  mutation DeleteProject($id: String!) {
    projectDelete(id: $id) { success }
  }
`;

export async function deleteProject(id: string): Promise<boolean> {
  // NOT wrapped — re-running after first success would not-found.
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_PROJECT_MUTATION, { id })) as {
    data: { projectDelete: { success: boolean } };
  };
  return response.data.projectDelete.success;
}

// ---------- project updates (status posts with --health) ----------

export type ProjectHealth = "onTrack" | "atRisk" | "offTrack";

export interface ListedProjectUpdate {
  id: string;
  body: string;
  health: ProjectHealth | null;
  created_at: string;
  user: { id: string; name: string; email: string } | null;
}

// `Query.project(id)` takes `String!`, not `ID!` — Linear's inputs use
// String for entity-id args even though the underlying field is ID.
const LIST_PROJECT_UPDATES_QUERY = /* GraphQL */ `
  query ListProjectUpdates($projectId: String!, $first: Int!, $after: String) {
    project(id: $projectId) {
      projectUpdates(first: $first, after: $after) {
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

interface ProjectUpdatesPage {
  data: {
    project: {
      projectUpdates: {
        nodes: {
          id: string;
          body: string;
          health: ProjectHealth | null;
          createdAt: string;
          user: { id: string; name: string; email: string } | null;
        }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  };
}

interface ProjectUpdateNode {
  id: string;
  body: string;
  health: ProjectHealth | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

export async function listProjectUpdates(projectId: string): Promise<ListedProjectUpdate[]> {
  const client = await linear();
  const raw = await paginateRaw<ProjectUpdateNode, ProjectUpdatesPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_PROJECT_UPDATES_QUERY, {
        projectId,
        first,
        after,
      }) as Promise<ProjectUpdatesPage>,
    (response) => response.data.project?.projectUpdates ?? null,
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

export interface CreateProjectUpdateInput {
  projectId: string;
  body: string;
  health?: ProjectHealth;
}

const CREATE_PROJECT_UPDATE_MUTATION = /* GraphQL */ `
  mutation CreateProjectUpdate($input: ProjectUpdateCreateInput!) {
    projectUpdateCreate(input: $input) {
      success
      projectUpdate {
        id body health createdAt
        user { id name email }
      }
    }
  }
`;

export async function createProjectUpdate(
  input: CreateProjectUpdateInput,
): Promise<ListedProjectUpdate> {
  // NOT retry-wrapped — would post a duplicate update entry.
  const client = await linear();
  const response = (await client.client.rawRequest(CREATE_PROJECT_UPDATE_MUTATION, {
    input,
  })) as {
    data: {
      projectUpdateCreate: {
        success: boolean;
        projectUpdate: {
          id: string;
          body: string;
          health: ProjectHealth | null;
          createdAt: string;
          user: { id: string; name: string; email: string } | null;
        };
      };
    };
  };
  const u = response.data.projectUpdateCreate.projectUpdate;
  return {
    id: u.id,
    body: u.body,
    health: u.health,
    created_at: u.createdAt,
    user: u.user,
  };
}
