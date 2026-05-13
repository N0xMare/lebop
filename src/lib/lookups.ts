/**
 * Name → ID resolvers exposed as first-class lookup functions. Both `lookup_*`
 * MCP tools (state-by-name, user-by-email) wire here. Keeps the lookups
 * symmetric with the existing `resolveLabelByName` so agents have one mental
 * model: "lookup_X_by_Y returns the record or null, never throws on miss".
 *
 * State lookup is team-scoped (workflow states are per-team in Linear).
 * User lookup is workspace-scoped (users belong to organizations, not teams).
 */

import { withClient } from "./sdk.ts";

export interface FetchedState {
  id: string;
  name: string;
  type: string;
}

const LOOKUP_STATE_QUERY = /* GraphQL */ `
  query LookupState($name: String!, $teamKey: String!) {
    workflowStates(
      filter: { name: { eq: $name }, team: { key: { eq: $teamKey } } }
      first: 1
    ) {
      nodes { id name type }
    }
  }
`;

/**
 * Resolve a workflow state by name within a team's state set. Case-sensitive
 * — Linear's `name eq` filter is exact-match. Returns `null` when no state
 * with that name exists in the team.
 *
 * For a fuzzy / case-insensitive lookup, use the cached team metadata via
 * `resolveStateId` in `lib/resolve.ts` (which the issue create/update path
 * uses).
 */
export async function lookupStateByName(team: string, name: string): Promise<FetchedState | null> {
  const upperTeam = team.toUpperCase();
  const response = (await withClient((c) =>
    c.client.rawRequest(LOOKUP_STATE_QUERY, { name, teamKey: upperTeam }),
  )) as { data: { workflowStates: { nodes: FetchedState[] } } };
  return response.data.workflowStates.nodes[0] ?? null;
}

export interface FetchedUser {
  id: string;
  email: string;
  name: string;
  display_name: string | null;
  active: boolean;
}

interface UserNode {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  active: boolean;
}

const LOOKUP_USER_QUERY = /* GraphQL */ `
  query LookupUser($email: String!) {
    users(filter: { email: { eq: $email } }, first: 1) {
      nodes {
        id
        email
        name
        displayName
        active
      }
    }
  }
`;

/**
 * Resolve a workspace user by email. Exact-match (case-insensitive against
 * Linear's index). Returns `null` if no user has that email — matches the
 * wave-1 `get_*` contract for missing entities.
 */
export async function lookupUserByEmail(email: string): Promise<FetchedUser | null> {
  const response = (await withClient((c) => c.client.rawRequest(LOOKUP_USER_QUERY, { email }))) as {
    data: { users: { nodes: UserNode[] } };
  };
  const node = response.data.users.nodes[0];
  if (!node) return null;
  return {
    id: node.id,
    email: node.email,
    name: node.name,
    display_name: node.displayName,
    active: node.active,
  };
}
