/**
 * Per-team workflow states (Backlog, Todo, In Progress, Done, Cancelled —
 * varies per team setup). Thin wrapper over what's already in the team
 * metadata cache + a live `team.states()` call for fields the cache doesn't
 * carry (color, default flag).
 *
 * Distinct from `lookup_state_by_name` (in `lib/lookups.ts`) which is a
 * single-state by-exact-name resolver. This one returns the full per-team
 * state set.
 */

import { tryMapToNull } from "./errors.ts";
import { paginateRaw } from "./paginate.ts";
import { linear } from "./sdk.ts";

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
  color: string | null;
  default: boolean;
}

interface WorkflowStateNode {
  id: string;
  name: string;
  type: string;
  color: string | null;
}

interface TeamWithStatesPage {
  data: {
    teams: {
      nodes: Array<{
        id: string;
        key: string;
        name: string;
        defaultIssueState: { id: string } | null;
        states: {
          nodes: WorkflowStateNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>;
    };
  };
}

// Paginated query — walks the `states` connection until `hasNextPage` is
// false. The outer `teams(...)` filter is repeated per page (cheap; we
// always want the same team) but `states(first, after)` advances. Both the
// team metadata (defaultIssueState) and the first batch of state nodes
// come back together on page 1; subsequent pages drop the team-level
// fields unless we re-request them (we do — same query shape per page).
const LIST_STATES_PAGED_QUERY = /* GraphQL */ `
  query ListWorkflowStates($key: String!, $first: Int!, $after: String) {
    teams(filter: { key: { eq: $key } }, first: 1) {
      nodes {
        id
        key
        name
        defaultIssueState { id }
        states(first: $first, after: $after) {
          nodes { id name type color }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export interface ListWorkflowStatesResult {
  team: string;
  states: WorkflowState[];
}

/**
 * Fetch every workflow state for a team plus a `default` flag marking the
 * team's default-issue-state. Returns null if the team key doesn't resolve
 * (matches the wave-1 `get_*` shape; caller can re-shape).
 *
 * Paginates the `team.states` connection — most teams have 5-10 states but
 * mature setups can have 20+; this guards against any future Linear API
 * default-limit changes.
 */
export async function listWorkflowStates(
  teamKey: string,
): Promise<ListWorkflowStatesResult | null> {
  const upper = teamKey.toUpperCase();
  const client = await linear();
  // Capture team-level metadata from the first page (default state id +
  // canonical team key). Subsequent pages echo the same fields; we keep
  // the first-page snapshot.
  let teamKeyCanonical: string | null = null;
  let defaultStateId: string | null = null;
  let firstPageSeen = false;

  return tryMapToNull(async () => {
    const nodes = await paginateRaw<WorkflowStateNode, TeamWithStatesPage>(
      ({ first, after }) =>
        client.client.rawRequest(LIST_STATES_PAGED_QUERY, {
          key: upper,
          first,
          after,
        }) as Promise<TeamWithStatesPage>,
      (response) => {
        const team = response.data.teams.nodes[0];
        if (!team) return null;
        if (!firstPageSeen) {
          teamKeyCanonical = team.key;
          defaultStateId = team.defaultIssueState?.id ?? null;
          firstPageSeen = true;
        }
        return team.states;
      },
      { pageSize: 250 },
    );
    if (!firstPageSeen) return null;
    const states: WorkflowState[] = nodes.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      color: s.color,
      default: defaultStateId !== null && s.id === defaultStateId,
    }));
    return { team: teamKeyCanonical ?? upper, states };
  });
}
