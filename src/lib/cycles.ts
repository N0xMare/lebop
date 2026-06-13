/**
 * Cycle list/view. Linear cycles are per-team iterations (sprints). Each
 * cycle has a number, name, startsAt, endsAt, and computed metrics
 * (issue counts, completed counts, etc.). Mutating cycles isn't part of
 * lebop's surface — cycles are scheduled/managed in Linear's UI.
 */

import { tryMapToNull } from "./errors.ts";
import { type ConnectionPage, paginateRaw, paginateRawPage } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedCycle {
  id: string;
  name: string | null;
  number: number;
  starts_at: string;
  ends_at: string;
  completed_at: string | null;
  archived_at: string | null;
  team: { id: string; key: string; name: string };
}

const LIST_CYCLES_QUERY = /* GraphQL */ `
  query ListCycles($filter: CycleFilter, $first: Int!, $after: String) {
    cycles(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        name
        number
        startsAt
        endsAt
        completedAt
        archivedAt
        team { id key name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface CycleNode {
  id: string;
  name: string | null;
  number: number;
  startsAt: string;
  endsAt: string;
  completedAt: string | null;
  archivedAt: string | null;
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
    number: c.number,
    starts_at: c.startsAt,
    ends_at: c.endsAt,
    completed_at: c.completedAt,
    archived_at: c.archivedAt,
    team: c.team,
  };
}

export async function listCycles(
  opts: { team?: string; search?: string; max?: number } = {},
): Promise<ListedCycle[]> {
  const filter = buildCycleFilter(opts);
  const client = await linear();
  const raw = await paginateRaw<CycleNode, CyclesPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_CYCLES_QUERY, {
        filter,
        first,
        after,
      }) as Promise<CyclesPage>,
    (response) => response.data.cycles,
    { pageSize: 250, max: opts.max },
  );
  return raw.map(shape);
}

export async function listCyclesPage(
  opts: { team?: string; search?: string; limit: number; after?: string } = { limit: 25 },
): Promise<ConnectionPage<ListedCycle>> {
  const filter = buildCycleFilter(opts);
  const client = await linear();
  const page = await paginateRawPage<CycleNode, CyclesPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_CYCLES_QUERY, {
        filter,
        first,
        after,
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
      id
      name
      number
      startsAt
      endsAt
      completedAt
      archivedAt
      team { id key name }
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
