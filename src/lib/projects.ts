/**
 * Project CRUD + project-update (status updates with health) over Linear's
 * Project + ProjectUpdate surfaces. Used by `lebop project ...`,
 * `lebop project-update ...`, and the MCP equivalents.
 */

import { NotFoundError, tryMapToNull, ValidationError } from "./errors.ts";
import { assertIconNotEmoji } from "./icons.ts";
import { requireMutationEntity, requireMutationSuccess } from "./mutationResult.ts";
import {
  type ConnectionPage,
  paginateConnection,
  paginateConnectionPage,
  paginateRaw,
  paginateRawPage,
} from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedProject {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  state: string;
  url: string;
  updated_at: string;
  // Round-7 / MED-1: parity with FullProject, ListedMilestone,
  // ListedInitiative, ListedDocument, ListedCycle. Pre-fix only FullProject
  // surfaced archive state; list_projects callers couldn't tell archived
  // from live without a separate get_project call.
  archived_at: string | null;
}

export async function listProjects(opts: {
  team?: string;
  state?: string;
  search?: string;
  includeArchived?: boolean;
  max?: number;
}): Promise<ListedProject[]> {
  const client = await linear();
  // Push state filter to GraphQL so `max` counts post-filter results.
  // (`projects.state` is a String filter on the project's state name.)
  const filter = buildProjectFilter(opts);

  if (opts.team) {
    // Team-scoped: walk team.projects
    const teams = await withClient((c) => c.teams({ filter: { key: { eq: opts.team } } }));
    const team = teams.nodes[0];
    if (!team)
      throw new NotFoundError(
        `team not found: ${opts.team}`,
        "verify the team key (e.g. `UE`) and that your token has access to it",
      );
    const projects = await paginateConnection(
      ({ first, after }) =>
        team.projects({ first, after, filter, includeArchived: opts.includeArchived } as Parameters<
          typeof team.projects
        >[0]),
      { max: opts.max },
    );
    return projects.map(shapeProject);
  }

  // Workspace-wide listing
  const projects = await paginateConnection(
    ({ first, after }) =>
      client.projects({ first, after, filter, includeArchived: opts.includeArchived } as Parameters<
        typeof client.projects
      >[0]),
    { max: opts.max },
  );
  return projects.map(shapeProject);
}

export async function listProjectsPage(opts: {
  team?: string;
  state?: string;
  search?: string;
  includeArchived?: boolean;
  after?: string;
  limit: number;
}): Promise<ConnectionPage<ListedProject>> {
  const client = await linear();
  const filter = buildProjectFilter(opts);

  if (opts.team) {
    const teams = await withClient((c) => c.teams({ filter: { key: { eq: opts.team } } }));
    const team = teams.nodes[0];
    if (!team)
      throw new NotFoundError(
        `team not found: ${opts.team}`,
        "verify the team key (e.g. `UE`) and that your token has access to it",
      );
    const page = await paginateConnectionPage(
      ({ first, after }) =>
        team.projects({ first, after, filter, includeArchived: opts.includeArchived } as Parameters<
          typeof team.projects
        >[0]),
      { limit: opts.limit, after: opts.after },
    );
    return { nodes: page.nodes.map(shapeProject), pageInfo: page.pageInfo };
  }

  const page = await paginateConnectionPage(
    ({ first, after }) =>
      client.projects({ first, after, filter, includeArchived: opts.includeArchived } as Parameters<
        typeof client.projects
      >[0]),
    { limit: opts.limit, after: opts.after },
  );
  return { nodes: page.nodes.map(shapeProject), pageInfo: page.pageInfo };
}

function buildProjectFilter(opts: {
  state?: string;
  search?: string;
}): Record<string, unknown> | undefined {
  const filter: Record<string, unknown> = {};
  if (opts.state) filter.state = { eq: opts.state };
  if (opts.search) filter.searchableContent = { contains: opts.search };
  return Object.keys(filter).length > 0 ? filter : undefined;
}

function shapeProject(p: {
  id: string;
  name: string;
  description: string | null;
  icon?: string | null;
  state: string;
  url: string;
  updatedAt: Date;
  archivedAt?: Date | null;
}): ListedProject {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    icon: p.icon ?? null,
    state: p.state,
    url: p.url,
    updated_at: p.updatedAt.toISOString(),
    // SDK returns `archivedAt` as a Date or undefined; lebop emits the
    // snake_case string-or-null shape used everywhere else.
    archived_at: p.archivedAt instanceof Date ? p.archivedAt.toISOString() : (p.archivedAt ?? null),
  };
}

export interface FullProject {
  id: string;
  name: string;
  description: string | null;
  content: string | null;
  icon: string | null;
  state: string;
  url: string;
  updated_at: string;
  start_date: string | null;
  target_date: string | null;
  // Round-6 / M3: parity with ListedInitiative/ListedMilestone/ListedDocument/
  // ListedCycle. `project(id:)` cleanly returns archived rows (no
  // archive-bug), so callers can distinguish live vs. archived via this
  // field without needing the list-shape archive workaround.
  archived_at: string | null;
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
      icon
      state
      url
      updatedAt
      startDate
      targetDate
      archivedAt
      teams { nodes { id key name } }
      lead { id name email }
    }
  }
`;

export async function getProject(id: string): Promise<FullProject | null> {
  // `tryMapToNull` turns SDK-boundary `NotFoundError` into a `null` return
  // (the documented "missing → null" contract) while propagating every
  // other error subtype unchanged. Replaces the prior try/catch +
  // `mapSdkError` + `instanceof` boilerplate.
  type Resp = {
    data: {
      project: {
        id: string;
        name: string;
        description: string | null;
        content: string | null;
        icon: string | null;
        state: string;
        url: string;
        updatedAt: string;
        startDate: string | null;
        targetDate: string | null;
        archivedAt: string | null;
        teams: { nodes: { id: string; key: string; name: string }[] };
        lead: { id: string; name: string; email: string } | null;
      } | null;
    };
  };
  const response = await tryMapToNull<Resp>(
    () => withClient((c) => c.client.rawRequest(GET_PROJECT_QUERY, { id })) as Promise<Resp>,
  );
  if (!response) return null;
  const p = response.data.project;
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    content: p.content,
    icon: p.icon,
    state: p.state,
    url: p.url,
    updated_at: p.updatedAt,
    start_date: p.startDate,
    target_date: p.targetDate,
    archived_at: p.archivedAt,
    teams: p.teams.nodes,
    lead: p.lead,
  };
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  content?: string;
  icon?: string;
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
        id name description content icon state url updatedAt startDate targetDate archivedAt
        teams { nodes { id key name } }
        lead { id name email }
      }
    }
  }
`;

export async function createProject(input: CreateProjectInput): Promise<FullProject> {
  assertIconNotEmoji(input.icon);
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
          icon: string | null;
          state: string;
          url: string;
          updatedAt: string;
          startDate: string | null;
          targetDate: string | null;
          archivedAt: string | null;
          teams: { nodes: { id: string; key: string; name: string }[] };
          lead: { id: string; name: string; email: string } | null;
        };
      };
    };
  };
  const p = requireMutationEntity<(typeof response.data.projectCreate)["project"]>(
    "projectCreate",
    response.data.projectCreate,
    "project",
  );
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    content: p.content,
    icon: p.icon,
    state: p.state,
    url: p.url,
    updated_at: p.updatedAt,
    start_date: p.startDate,
    target_date: p.targetDate,
    archived_at: p.archivedAt,
    teams: p.teams.nodes,
    lead: p.lead,
  };
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  content?: string;
  icon?: string | null;
  state?: string;
  startDate?: string | null;
  targetDate?: string | null;
}

const UPDATE_PROJECT_MUTATION = /* GraphQL */ `
  mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
      project {
        id name description content icon state url updatedAt startDate targetDate archivedAt
        teams { nodes { id key name } }
        lead { id name email }
      }
    }
  }
`;

export async function updateProject(id: string, input: UpdateProjectInput): Promise<FullProject> {
  assertIconNotEmoji(input.icon ?? undefined);
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
          icon: string | null;
          state: string;
          url: string;
          updatedAt: string;
          startDate: string | null;
          targetDate: string | null;
          archivedAt: string | null;
          teams: { nodes: { id: string; key: string; name: string }[] };
          lead: { id: string; name: string; email: string } | null;
        };
      };
    };
  };
  const p = requireMutationEntity<(typeof response.data.projectUpdate)["project"]>(
    "projectUpdate",
    response.data.projectUpdate,
    "project",
  );
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    content: p.content,
    icon: p.icon,
    state: p.state,
    url: p.url,
    updated_at: p.updatedAt,
    start_date: p.startDate,
    target_date: p.targetDate,
    archived_at: p.archivedAt,
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
  // Round-7 / Q2 (refined): Linear's `projectDelete` is a SOFT delete —
  // sets `archivedAt` on the project; the delete mutation returns
  // `success: true` on any id. Pre-flight + archived_at check so
  // `tryIdempotentDelete` callers see consistent `{status:
  // "already-absent"}` on re-runs.
  const existing = await getProject(id);
  if (!existing || existing.archived_at !== null) {
    throw new NotFoundError(
      `project not found: ${id}`,
      "the project may have already been deleted",
    );
  }
  // NOT retry-wrapped — second call would not-found after the pre-flight delete.
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_PROJECT_MUTATION, { id })) as {
    data: { projectDelete: { success: boolean } };
  };
  requireMutationSuccess("projectDelete", response.data.projectDelete);
  return true;
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

export async function listProjectUpdates(
  projectId: string,
  opts: { max?: number } = {},
): Promise<ListedProjectUpdate[]> {
  const client = await linear();
  const raw = await paginateRaw<ProjectUpdateNode, ProjectUpdatesPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_PROJECT_UPDATES_QUERY, {
        projectId,
        first,
        after,
      }) as Promise<ProjectUpdatesPage>,
    (response) => {
      const project = response.data.project;
      if (!project) {
        throw new NotFoundError(
          `project not found: ${projectId}`,
          "verify the project UUID or resolve the project name again before listing updates",
        );
      }
      return project.projectUpdates;
    },
    { pageSize: 250, max: opts.max },
  );
  return raw.map(shapeProjectUpdate);
}

export async function listProjectUpdatesPage(
  projectId: string,
  opts: { limit: number; after?: string },
): Promise<ConnectionPage<ListedProjectUpdate>> {
  const client = await linear();
  const page = await paginateRawPage<ProjectUpdateNode, ProjectUpdatesPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_PROJECT_UPDATES_QUERY, {
        projectId,
        first,
        after,
      }) as Promise<ProjectUpdatesPage>,
    (response) => {
      const project = response.data.project;
      if (!project) {
        throw new NotFoundError(
          `project not found: ${projectId}`,
          "verify the project UUID or resolve the project name again before listing updates",
        );
      }
      return project.projectUpdates;
    },
    { limit: opts.limit, after: opts.after, pageSize: 250 },
  );
  return { nodes: page.nodes.map(shapeProjectUpdate), pageInfo: page.pageInfo };
}

function shapeProjectUpdate(u: ProjectUpdateNode): ListedProjectUpdate {
  return {
    id: u.id,
    body: u.body,
    health: u.health,
    created_at: u.createdAt,
    user: u.user,
  };
}

export interface CreateProjectUpdateInput {
  projectId: string;
  body: string;
  health?: ProjectHealth;
}

export function assertProjectUpdateBody(body: string): void {
  if (body.trim().length === 0) {
    throw new ValidationError(
      "empty project update body",
      "pass a non-empty body via --body, --body-file, stdin, or MCP body",
    );
  }
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
  assertProjectUpdateBody(input.body);

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
  const u = requireMutationEntity<(typeof response.data.projectUpdateCreate)["projectUpdate"]>(
    "projectUpdateCreate",
    response.data.projectUpdateCreate,
    "projectUpdate",
  );
  return {
    id: u.id,
    body: u.body,
    health: u.health,
    created_at: u.createdAt,
    user: u.user,
  };
}
