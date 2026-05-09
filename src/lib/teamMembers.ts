/**
 * Team members — list users in a team. Linear's TeamMembership join joins
 * Team to User, with `active` and `owner` flags.
 */

import { paginateRaw } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedTeamMember {
  id: string;
  name: string;
  email: string;
  display_name: string | null;
  is_owner: boolean;
  active: boolean;
  team: { id: string; key: string; name: string };
}

const LIST_TEAM_MEMBERS_QUERY = /* GraphQL */ `
  query ListTeamMembers($teamKey: String!, $first: Int!, $after: String) {
    teamMemberships(filter: { team: { key: { eq: $teamKey } } }, first: $first, after: $after) {
      nodes {
        id
        owner
        team { id key name }
        user {
          id
          name
          email
          displayName
          active
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface MembershipNode {
  id: string;
  owner: boolean;
  team: { id: string; key: string; name: string };
  user: {
    id: string;
    name: string;
    email: string;
    displayName: string | null;
    active: boolean;
  };
}

interface MembershipPage {
  data: {
    teamMemberships: {
      nodes: MembershipNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

export async function listTeamMembers(opts: {
  teamKey: string;
  includeInactive?: boolean;
  max?: number;
}): Promise<ListedTeamMember[]> {
  const client = await linear();
  const raw = await paginateRaw<MembershipNode, MembershipPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_TEAM_MEMBERS_QUERY, {
        teamKey: opts.teamKey,
        first,
        after,
      }) as Promise<MembershipPage>,
    (response) => response.data.teamMemberships,
    { pageSize: 250, max: opts.max },
  );

  return raw
    .map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      display_name: m.user.displayName,
      is_owner: m.owner,
      active: m.user.active,
      team: m.team,
    }))
    .filter((m) => opts.includeInactive || m.active);
}

// `withClient` re-export for testability — keeps tests from importing from
// sdk.ts directly when only the team-member helpers are exercised.
export { withClient };
