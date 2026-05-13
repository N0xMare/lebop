/**
 * Team-level reads beyond `lebop teams` (list). `getTeam` resolves a team key
 * OR UUID to a single shaped record — fills the team-key → UUID gap that
 * bites create_label, create_project, and any other surface that takes a
 * `team_id` UUID input.
 *
 * Distinct from `lib/teamMembers.ts` (which only handles the members
 * connection) and `lib/resolve.ts:getTeamMetadata` (which builds the full
 * states/labels/members/projects cache used by name resolution). This file
 * exists for the narrow "give me one team" shape.
 */

import { tryMapToNull } from "./errors.ts";
import { withClient } from "./sdk.ts";
import { isUuid } from "./uuid.ts";

export interface FetchedTeam {
  id: string;
  key: string;
  name: string;
  description: string | null;
  default_state_id: string | null;
  default_state_name: string | null;
}

interface TeamNode {
  id: string;
  key: string;
  name: string;
  description: string | null;
  defaultIssueState: { id: string; name: string } | null;
}

const GET_TEAM_BY_ID_QUERY = /* GraphQL */ `
  query GetTeamById($id: String!) {
    team(id: $id) {
      id
      key
      name
      description
      defaultIssueState { id name }
    }
  }
`;

const GET_TEAM_BY_KEY_QUERY = /* GraphQL */ `
  query GetTeamByKey($key: String!) {
    teams(filter: { key: { eq: $key } }, first: 1) {
      nodes {
        id
        key
        name
        description
        defaultIssueState { id name }
      }
    }
  }
`;

function shape(t: TeamNode): FetchedTeam {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    description: t.description,
    default_state_id: t.defaultIssueState?.id ?? null,
    default_state_name: t.defaultIssueState?.name ?? null,
  };
}

/**
 * Fetch one team by key (e.g. "NOX") or UUID. Returns `null` when no team
 * matches — matches the wave-1 `get_*` contract. Other errors (auth, network,
 * etc.) surface through `tryMapToNull` per the standard SDK boundary.
 */
export async function getTeam(keyOrId: string): Promise<FetchedTeam | null> {
  if (isUuid(keyOrId)) {
    type Resp = { data: { team: TeamNode | null } };
    const response = await tryMapToNull<Resp>(
      () =>
        withClient((c) =>
          c.client.rawRequest(GET_TEAM_BY_ID_QUERY, { id: keyOrId }),
        ) as Promise<Resp>,
    );
    if (!response) return null;
    return response.data.team ? shape(response.data.team) : null;
  }
  // Key lookup — filter via teams(filter: { key: { eq } }).
  // Round-6 / M1: wrap in `tryMapToNull` to mirror the UUID branch. List
  // queries don't throw NotFoundError today, so the wrap is structurally
  // a no-op — but if Linear ever returns a structured `not_found`
  // extension on the key branch (e.g., per-key validation), the UUID
  // branch would return null and the key branch would propagate. Pin both
  // sides of the function to the same contract.
  type KeyResp = { data: { teams: { nodes: TeamNode[] } } };
  const upper = keyOrId.toUpperCase();
  const response = await tryMapToNull<KeyResp>(
    () =>
      withClient((c) =>
        c.client.rawRequest(GET_TEAM_BY_KEY_QUERY, { key: upper }),
      ) as Promise<KeyResp>,
  );
  if (!response) return null;
  const node = response.data.teams.nodes[0];
  return node ? shape(node) : null;
}
