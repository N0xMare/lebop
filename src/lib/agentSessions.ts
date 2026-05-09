/**
 * Agent sessions — Linear's first-class concept for AI/agent activity on
 * issues. Read-only via lebop; sessions are created/managed by the agents
 * themselves.
 */

import { paginateRaw } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedAgentSession {
  id: string;
  status: string | null;
  type: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  issue: { id: string; identifier: string; title: string } | null;
  creator: { id: string; name: string; email: string } | null;
}

const LIST_AGENT_SESSIONS_QUERY = /* GraphQL */ `
  query ListAgentSessions($filter: AgentSessionFilter, $first: Int!, $after: String) {
    agentSessions(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        status
        type
        createdAt
        updatedAt
        endedAt
        issue { id identifier title }
        creator { id name email }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface AgentSessionNode {
  id: string;
  status: string | null;
  type: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  issue: { id: string; identifier: string; title: string } | null;
  creator: { id: string; name: string; email: string } | null;
}

interface AgentSessionsPage {
  data: {
    agentSessions: {
      nodes: AgentSessionNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

function shape(s: AgentSessionNode): ListedAgentSession {
  return {
    id: s.id,
    status: s.status,
    type: s.type,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    ended_at: s.endedAt,
    issue: s.issue,
    creator: s.creator,
  };
}

export async function listAgentSessions(opts: {
  status?: string;
  issueId?: string;
  max?: number;
}): Promise<ListedAgentSession[]> {
  const filter: Record<string, unknown> = {};
  if (opts.status) filter.status = { eq: opts.status };
  if (opts.issueId) filter.issue = { id: { eq: opts.issueId } };

  const client = await linear();
  const raw = await paginateRaw<AgentSessionNode, AgentSessionsPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_AGENT_SESSIONS_QUERY, {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first,
        after,
      }) as Promise<AgentSessionsPage>,
    (response) => response.data.agentSessions,
    { pageSize: 250, max: opts.max },
  );
  return raw.map(shape);
}

const GET_AGENT_SESSION_QUERY = /* GraphQL */ `
  query GetAgentSession($id: String!) {
    agentSession(id: $id) {
      id
      status
      type
      createdAt
      updatedAt
      endedAt
      issue { id identifier title }
      creator { id name email }
    }
  }
`;

export async function getAgentSession(id: string): Promise<ListedAgentSession | null> {
  const response = (await withClient((c) =>
    c.client.rawRequest(GET_AGENT_SESSION_QUERY, { id }),
  )) as { data: { agentSession: AgentSessionNode | null } };
  return response.data.agentSession ? shape(response.data.agentSession) : null;
}
