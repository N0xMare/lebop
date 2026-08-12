/**
 * Cycle list/view/create/update/archive. Linear cycles are per-team iterations
 * (sprints). Each cycle has a server-assigned number, optional name/description,
 * startsAt/endsAt, and computed status flags (isActive, isNext, …).
 *
 * First-class surface: list, get, create, update, archive.
 * Assign issues via `set cycle` / update_issue — not cycle object verbs.
 * No unarchive / hard delete / shift-all / start-upcoming first-class.
 */

import { tryMapToNull } from "./errors.ts";
import { requireMutationEntity, requireMutationSuccess } from "./mutationResult.ts";
import { type ConnectionPage, paginateRaw, paginateRawPage } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedCycle {
  id: string;
  name: string | null;
  description: string | null;
  number: number;
  starts_at: string;
  ends_at: string;
  completed_at: string | null;
  archived_at: string | null;
  is_active: boolean;
  is_next: boolean;
  is_past: boolean;
  is_future: boolean;
  is_previous: boolean;
  team: { id: string; key: string; name: string };
}

const CYCLE_NODE_FIELDS = /* GraphQL */ `
  id
  name
  description
  number
  startsAt
  endsAt
  completedAt
  archivedAt
  isActive
  isNext
  isPast
  isFuture
  isPrevious
  team { id key name }
`;

const LIST_CYCLES_QUERY = /* GraphQL */ `
  query ListCycles(
    $filter: CycleFilter
    $first: Int!
    $after: String
    $includeArchived: Boolean
  ) {
    cycles(filter: $filter, first: $first, after: $after, includeArchived: $includeArchived) {
      nodes {
        ${CYCLE_NODE_FIELDS}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface CycleNode {
  id: string;
  name: string | null;
  description: string | null;
  number: number;
  startsAt: string;
  endsAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  isActive: boolean;
  isNext: boolean;
  isPast: boolean;
  isFuture: boolean;
  isPrevious: boolean;
  team: { id: string; key: string; name: string };
}

interface CyclesPage {
  data: {
    cycles: {
      nodes: CycleNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

function shape(c: CycleNode): ListedCycle {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    number: c.number,
    starts_at: c.startsAt,
    ends_at: c.endsAt,
    completed_at: c.completedAt,
    archived_at: c.archivedAt,
    is_active: c.isActive,
    is_next: c.isNext,
    is_past: c.isPast,
    is_future: c.isFuture,
    is_previous: c.isPrevious,
    team: c.team,
  };
}

export async function listCycles(
  opts: { team?: string; search?: string; includeArchived?: boolean; max?: number } = {},
): Promise<ListedCycle[]> {
  const filter = buildCycleFilter(opts);
  const client = await linear();
  const raw = await paginateRaw<CycleNode, CyclesPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_CYCLES_QUERY, {
        filter,
        first,
        after,
        includeArchived: Boolean(opts.includeArchived),
      }) as Promise<CyclesPage>,
    (response) => response.data.cycles,
    { pageSize: 250, max: opts.max },
  );
  return raw.map(shape);
}

export async function listCyclesPage(
  opts: {
    team?: string;
    search?: string;
    includeArchived?: boolean;
    limit: number;
    after?: string;
  } = { limit: 25 },
): Promise<ConnectionPage<ListedCycle>> {
  const filter = buildCycleFilter(opts);
  const client = await linear();
  const page = await paginateRawPage<CycleNode, CyclesPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_CYCLES_QUERY, {
        filter,
        first,
        after,
        includeArchived: Boolean(opts.includeArchived),
      }) as Promise<CyclesPage>,
    (response) => response.data.cycles,
    { limit: opts.limit, after: opts.after, pageSize: 250 },
  );
  return { nodes: page.nodes.map(shape), pageInfo: page.pageInfo };
}

function buildCycleFilter(opts: {
  team?: string;
  search?: string;
}): Record<string, unknown> | undefined {
  const filter: Record<string, unknown> = {};
  if (opts.team) filter.team = { key: { eq: opts.team } };
  if (opts.search) filter.name = { containsIgnoreCase: opts.search };
  return Object.keys(filter).length > 0 ? filter : undefined;
}

const GET_CYCLE_QUERY = /* GraphQL */ `
  query GetCycle($id: String!) {
    cycle(id: $id) {
      ${CYCLE_NODE_FIELDS}
    }
  }
`;

export async function getCycle(id: string): Promise<ListedCycle | null> {
  // `tryMapToNull` preserves the documented "missing → null" contract while
  // propagating other LebopError subtypes unchanged.
  type Resp = { data: { cycle: CycleNode | null } };
  const response = await tryMapToNull<Resp>(
    () => withClient((c) => c.client.rawRequest(GET_CYCLE_QUERY, { id })) as Promise<Resp>,
  );
  if (!response) return null;
  return response.data.cycle ? shape(response.data.cycle) : null;
}

export interface CreateCycleInput {
  teamId: string;
  startsAt: string;
  endsAt: string;
  name?: string;
  description?: string;
}

const CREATE_CYCLE_MUTATION = /* GraphQL */ `
  mutation CreateCycle($input: CycleCreateInput!) {
    cycleCreate(input: $input) {
      success
      cycle {
        ${CYCLE_NODE_FIELDS}
      }
    }
  }
`;

export async function createCycle(input: CreateCycleInput): Promise<ListedCycle> {
  // NOT retry-wrapped — non-idempotent.
  const client = await linear();
  const response = (await client.client.rawRequest(CREATE_CYCLE_MUTATION, {
    input: {
      teamId: input.teamId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      name: input.name,
      description: input.description,
    },
  })) as {
    data: { cycleCreate: { success: boolean; cycle: CycleNode } };
  };
  const cycle = requireMutationEntity<CycleNode>("cycleCreate", response.data.cycleCreate, "cycle");
  return shape(cycle);
}

export interface UpdateCycleInput {
  name?: string;
  description?: string | null;
  startsAt?: string;
  endsAt?: string;
  /** ISO DateTime to mark complete; null clears completion. */
  completedAt?: string | null;
}

const UPDATE_CYCLE_MUTATION = /* GraphQL */ `
  mutation UpdateCycle($id: String!, $input: CycleUpdateInput!) {
    cycleUpdate(id: $id, input: $input) {
      success
      cycle {
        ${CYCLE_NODE_FIELDS}
      }
    }
  }
`;

export async function updateCycle(id: string, input: UpdateCycleInput): Promise<ListedCycle> {
  // Value-level idempotent — same input → same outcome.
  const gqlInput: Record<string, unknown> = {};
  if (input.name !== undefined) gqlInput.name = input.name;
  if (input.description !== undefined) gqlInput.description = input.description;
  if (input.startsAt !== undefined) gqlInput.startsAt = input.startsAt;
  if (input.endsAt !== undefined) gqlInput.endsAt = input.endsAt;
  if (input.completedAt !== undefined) gqlInput.completedAt = input.completedAt;

  const response = (await withClient((c) =>
    c.client.rawRequest(UPDATE_CYCLE_MUTATION, { id, input: gqlInput }),
  )) as {
    data: { cycleUpdate: { success: boolean; cycle: CycleNode } };
  };
  const cycle = requireMutationEntity<CycleNode>("cycleUpdate", response.data.cycleUpdate, "cycle");
  return shape(cycle);
}

const ARCHIVE_CYCLE_MUTATION = /* GraphQL */ `
  mutation ArchiveCycle($id: String!) {
    cycleArchive(id: $id) {
      success
    }
  }
`;

/**
 * Archive a cycle. Linear unlinks all issues currently assigned to the cycle
 * before archiving. There is no cycleUnarchive mutation.
 */
export async function archiveCycle(id: string): Promise<boolean> {
  // NOT retry-wrapped — re-run may surface not-found.
  const client = await linear();
  const response = (await client.client.rawRequest(ARCHIVE_CYCLE_MUTATION, { id })) as {
    data: { cycleArchive: { success: boolean } };
  };
  requireMutationSuccess("cycleArchive", response.data.cycleArchive);
  return true;
}
