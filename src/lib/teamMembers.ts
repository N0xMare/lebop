/**
 * Team members — list users in a team via the team's memberships connection.
 *
 * Linear removed the `filter` arg on `Query.teamMemberships` in 2026, so
 * we resolve the team UUID first via `teams(filter: { key })`, then walk
 * `Team.memberships(first, after)`.
 */

import { NotFoundError } from "./errors.ts";
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

const LIST_TEAM_MEMBERSHIPS_QUERY = /* GraphQL */ `
  query ListTeamMemberships($teamId: String!, $first: Int!, $after: String) {
    team(id: $teamId) {
      id
      key
      name
      memberships(first: $first, after: $after) {
        nodes {
          id
          owner
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
  }
`;

interface MembershipNode {
  id: string;
  owner: boolean;
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
    team: {
      id: string;
      key: string;
      name: string;
      memberships: {
        nodes: MembershipNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  };
}

export async function listTeamMembers(opts: {
  teamKey: string;
  includeInactive?: boolean;
  max?: number;
}): Promise<ListedTeamMember[]> {
  const client = await linear();
  // Step 1: resolve key → UUID. teams(filter: {key}) still works.
  // Round-6 / M2: Linear's `team.key.eq` filter is case-sensitive. Match
  // the case-folding pattern used in `lookups.ts:lookupStateByName` so
  // `--team nox` works the same as `--team NOX` — every team key in the
  // canary workspace is all-caps by convention, but mixed-case keys exist
  // in the wild and bare lowercase user input shouldn't silently miss.
  const upperTeam = opts.teamKey.toUpperCase();
  const teams = await withClient((c) => c.teams({ filter: { key: { eq: upperTeam } } }));
  const team = teams.nodes[0];
  if (!team) {
    throw new NotFoundError(
      `team not found: ${opts.teamKey}`,
      "verify the team key (e.g. `UE`) and that your token has access to it",
    );
  }
  const teamRecord = { id: team.id, key: team.key, name: team.name };

  // Step 2: walk memberships through the team node.
  const raw = await paginateRaw<MembershipNode, MembershipPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_TEAM_MEMBERSHIPS_QUERY, {
        teamId: team.id,
        first,
        after,
      }) as Promise<MembershipPage>,
    (response) => response.data.team?.memberships ?? null,
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
      team: teamRecord,
    }))
    .filter((m) => opts.includeInactive || m.active);
}

// `withClient` re-export for testability — keeps tests from importing from
// sdk.ts directly when only the team-member helpers are exercised.
export { withClient };
