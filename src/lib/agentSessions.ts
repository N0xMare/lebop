/**
 * Agent sessions — Linear's first-class concept for AI/agent activity on
 * issues. Read-only via lebop; sessions are created/managed by the agents
 * themselves.
 *
 * Linear removed the `AgentSessionFilter` input type and the `filter` arg on
 * `Query.agentSessions` in 2026, so server-side filtering by status/issue is
 * gone. We walk the connection and filter client-side; for issue-scoped
 * lookups we go through `Issue.agentSessions` which is cheaper.
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

const LIST_ALL_AGENT_SESSIONS_QUERY = /* GraphQL */ `
  query ListAgentSessions($first: Int!, $after: String) {
    agentSessions(first: $first, after: $after) {
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

const LIST_ISSUE_AGENT_SESSIONS_QUERY = /* GraphQL */ `
  query ListIssueAgentSessions($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      agentSessions(first: $first, after: $after) {
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

interface AllSessionsPage {
  data: {
    agentSessions: {
      nodes: AgentSessionNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

interface IssueSessionsPage {
  data: {
    issue: {
      agentSessions: {
        nodes: AgentSessionNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
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
  const client = await linear();
  let raw: AgentSessionNode[];

  if (opts.issueId) {
    raw = await paginateRaw<AgentSessionNode, IssueSessionsPage>(
      ({ first, after }) =>
        client.client.rawRequest(LIST_ISSUE_AGENT_SESSIONS_QUERY, {
          issueId: opts.issueId,
          first,
          after,
        }) as Promise<IssueSessionsPage>,
      (response) => response.data.issue?.agentSessions ?? null,
      { pageSize: 250, max: opts.max },
    );
  } else {
    raw = await paginateRaw<AgentSessionNode, AllSessionsPage>(
      ({ first, after }) =>
        client.client.rawRequest(LIST_ALL_AGENT_SESSIONS_QUERY, {
          first,
          after,
        }) as Promise<AllSessionsPage>,
      (response) => response.data.agentSessions,
      { pageSize: 250, max: opts.max },
    );
  }

  // Status filter is client-side: Linear removed the server-side filter.
  if (opts.status) {
    raw = raw.filter((s) => s.status === opts.status);
  }
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
