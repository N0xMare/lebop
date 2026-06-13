/**
 * Team members — list users in a team via the team's memberships connection.
 *
 * Linear removed the `filter` arg on `Query.teamMemberships` in 2026, so
 * we resolve the team UUID first via `teams(filter: { key })`, then walk
 * `Team.memberships(first, after)`.
 */

import { NotFoundError, ValidationError } from "./errors.ts";
import { type ConnectionPage, paginateRaw } from "./paginate.ts";
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
        edges {
          cursor
          node {
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
        edges?: { cursor: string | null; node: MembershipNode }[];
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
  const teamRecord = await resolveTeamRecord(opts.teamKey);

  // Step 2: walk memberships through the team node.
  const raw = await paginateRaw<MembershipNode, MembershipPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_TEAM_MEMBERSHIPS_QUERY, {
        teamId: teamRecord.id,
        first,
        after,
      }) as Promise<MembershipPage>,
    (response) => response.data.team?.memberships ?? null,
    { pageSize: 250, max: opts.max },
  );

  return raw.map((m) => shapeMember(m, teamRecord)).filter((m) => opts.includeInactive || m.active);
}

export async function listTeamMembersPage(opts: {
  teamKey: string;
  includeInactive?: boolean;
  limit: number;
  after?: string;
}): Promise<ConnectionPage<ListedTeamMember>> {
  const teamRecord = await resolveTeamRecord(opts.teamKey);
  const limit = Math.max(1, Math.floor(opts.limit));
  const nodes: ListedTeamMember[] = [];
  let after = opts.after;
  let pageInfo: ConnectionPage<ListedTeamMember>["pageInfo"] = {
    hasNextPage: false,
    endCursor: null,
  };
  const seenCursors = new Set<string>();
  if (after) seenCursors.add(after);

  while (nodes.length < limit) {
    const response = (await withClient((client) =>
      client.client.rawRequest(LIST_TEAM_MEMBERSHIPS_QUERY, {
        teamId: teamRecord.id,
        first: 250,
        after,
      }),
    )) as MembershipPage;
    const memberships = response.data.team?.memberships;
    if (!memberships) break;

    const edges = membershipEdges(memberships);
    let lastConsumedCursor: string | null = null;
    let consumedIndex = -1;
    for (const [index, edge] of edges.entries()) {
      const member = shapeMember(edge.node, teamRecord);
      lastConsumedCursor = edge.cursor;
      consumedIndex = index;
      if (opts.includeInactive || member.active) {
        nodes.push(member);
        if (nodes.length >= limit) break;
      }
    }

    const stoppedBeforePageEnd = consumedIndex >= 0 && consumedIndex < edges.length - 1;
    if (nodes.length >= limit) {
      const endCursor = lastConsumedCursor ?? memberships.pageInfo.endCursor ?? null;
      if ((stoppedBeforePageEnd || memberships.pageInfo.hasNextPage) && !endCursor) {
        throw new ValidationError(
          `team member page for ${teamRecord.key} cannot continue`,
          "Linear returned more membership rows without an edge cursor",
        );
      }
      pageInfo = {
        hasNextPage: stoppedBeforePageEnd || memberships.pageInfo.hasNextPage,
        endCursor,
      };
      break;
    }

    pageInfo = {
      hasNextPage: memberships.pageInfo.hasNextPage,
      endCursor: memberships.pageInfo.endCursor ?? null,
    };
    if (!memberships.pageInfo.hasNextPage) break;
    if (!memberships.pageInfo.endCursor) {
      throw new ValidationError(
        `team member page for ${teamRecord.key} cannot continue`,
        "Linear returned hasNextPage without endCursor",
      );
    }
    if (seenCursors.has(memberships.pageInfo.endCursor)) {
      throw new ValidationError(
        `team member page for ${teamRecord.key} cursor did not advance`,
        "Linear returned the same membership endCursor on consecutive pages",
      );
    }
    after = memberships.pageInfo.endCursor;
    seenCursors.add(after);
  }

  return { nodes, pageInfo };
}

function membershipEdges(memberships: {
  nodes: MembershipNode[];
  edges?: { cursor: string | null; node: MembershipNode }[];
  pageInfo: { endCursor: string | null };
}): { cursor: string | null; node: MembershipNode }[] {
  if (memberships.edges && memberships.edges.length > 0) return memberships.edges;
  return memberships.nodes.map((node, index) => ({
    node,
    cursor:
      index === memberships.nodes.length - 1 ? (memberships.pageInfo.endCursor ?? null) : null,
  }));
}

async function resolveTeamRecord(
  teamKey: string,
): Promise<{ id: string; key: string; name: string }> {
  // Step 1: resolve key -> UUID. teams(filter: {key}) still works.
  // Linear's `team.key.eq` filter is case-sensitive. Match the case-folding
  // pattern used elsewhere so `--team nox` works the same as `--team NOX`.
  const upperTeam = teamKey.toUpperCase();
  const teams = await withClient((c) => c.teams({ filter: { key: { eq: upperTeam } } }));
  const team = teams.nodes[0];
  if (!team) {
    throw new NotFoundError(
      `team not found: ${teamKey}`,
      "verify the team key (e.g. `UE`) and that your token has access to it",
    );
  }
  return { id: team.id, key: team.key, name: team.name };
}

function shapeMember(
  membership: MembershipNode,
  teamRecord: { id: string; key: string; name: string },
): ListedTeamMember {
  return {
    id: membership.user.id,
    name: membership.user.name,
    email: membership.user.email,
    display_name: membership.user.displayName,
    is_owner: membership.owner,
    active: membership.user.active,
    team: teamRecord,
  };
}

// `withClient` re-export for testability — keeps tests from importing from
// sdk.ts directly when only the team-member helpers are exercised.
export { withClient };
