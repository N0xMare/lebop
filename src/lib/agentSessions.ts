/**
 * Agent sessions — **read-only** research of Linear agent sessions created by
 * other systems (Cursor, Linear Agent, third-party apps). lebop is a Linear
 * control plane for external harnesses; it does not host app-actor agents or
 * emit Agent Activities.
 *
 * Linear removed the `AgentSessionFilter` input type and the `filter` arg on
 * `Query.agentSessions` in 2026, and issue-scoped lookups are not exposed as
 * an `Issue.agentSessions` field in the current API. We walk the top-level
 * connection and filter client-side.
 */

import { tryMapToNull, ValidationError } from "./errors.ts";
import { type ConnectionPage, resolveSafetyCap } from "./paginate.ts";
import { withRetry } from "./retry.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedAgentActivity {
  id: string;
  created_at: string;
  updated_at?: string | null;
  content: Record<string, unknown>;
  ephemeral?: boolean | null;
}

export interface ListedAgentSession {
  id: string;
  status: string | null;
  type: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  issue: { id: string; identifier: string; title: string } | null;
  creator: { id: string; name: string; email: string } | null;
  /** Present when fetched with includeActivities. */
  activities?: ListedAgentActivity[];
  plan?: unknown;
  external_urls?: { label?: string; url: string }[] | null;
}

const LIST_ALL_AGENT_SESSIONS_QUERY = /* GraphQL */ `
  query ListAgentSessions($first: Int!, $after: String) {
    agentSessions(first: $first, after: $after) {
      edges {
        cursor
        node {
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

interface AgentSessionEdge {
  cursor: string;
  node: AgentSessionNode;
}

interface AgentSessionConnection {
  edges: AgentSessionEdge[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface AllSessionsPage {
  data: {
    agentSessions: AgentSessionConnection;
  };
}

export interface AgentSessionsPage extends ConnectionPage<ListedAgentSession> {
  searchedCount: number;
}

const MAX_AGENT_SESSION_PAGE_SIZE = 250;

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
  const explicitMax = opts.max !== undefined;
  const max = opts.max ?? resolveSafetyCap();
  const page = await listAgentSessionsPage({
    status: opts.status,
    issueId: opts.issueId,
    limit: max,
  });
  if (!explicitMax && page.pageInfo.hasNextPage) {
    throw new ValidationError(
      `agent-session walk hit the safety cap of ${max} items but the connection still reports more pages`,
      `set LEBOP_MAX_ITEMS=N (where N > ${max}) to raise the ceiling, or pass a tighter filter`,
    );
  }
  return page.nodes;
}

export async function listAgentSessionsPage(opts: {
  status?: string;
  issueId?: string;
  search?: string;
  limit: number;
  after?: string;
}): Promise<AgentSessionsPage> {
  const client = await linear();
  const limit = Math.max(1, opts.limit);
  const rawScanLimit = Number.isFinite(limit) ? resolveSafetyCap() : Number.POSITIVE_INFINITY;
  const nodes: ListedAgentSession[] = [];
  const seenCursors = new Set<string>();
  let after = opts.after;
  let rawFetchedCount = 0;
  let searchedCount = 0;
  let pageInfo: AgentSessionsPage["pageInfo"] = { hasNextPage: false, endCursor: null };
  if (after) seenCursors.add(after);

  while (nodes.length < limit && rawFetchedCount < rawScanLimit) {
    const remaining = limit - nodes.length;
    const first = pageSizeFor({
      remaining,
      hasClientFilter: Boolean(opts.status || opts.search || opts.issueId),
      rawRemaining: rawScanLimit - rawFetchedCount,
    });
    const rawPage = await fetchAgentSessionRawPage(client, {
      first,
      after,
    });
    rawFetchedCount += rawPage.edges.length;
    let consumedCursor: string | null = null;
    let consumedAllEdges = true;

    for (let i = 0; i < rawPage.edges.length; i++) {
      const edge = rawPage.edges[i];
      if (!edge) continue;
      consumedCursor = edge.cursor;
      searchedCount += 1;
      const session = shape(edge.node);
      if (opts.issueId && session.issue?.id !== opts.issueId) continue;
      if (opts.status && session.status !== opts.status) continue;
      if (opts.search && !agentSessionMatches(session, opts.search)) continue;
      nodes.push(session);
      if (nodes.length >= limit) {
        consumedAllEdges = i === rawPage.edges.length - 1;
        break;
      }
    }

    pageInfo = {
      hasNextPage:
        nodes.length >= limit
          ? !consumedAllEdges || rawPage.pageInfo.hasNextPage
          : rawPage.pageInfo.hasNextPage,
      endCursor:
        nodes.length >= limit
          ? (consumedCursor ?? rawPage.pageInfo.endCursor ?? null)
          : (rawPage.pageInfo.endCursor ?? consumedCursor ?? null),
    };

    if (!pageInfo.hasNextPage) break;
    const nextCursor = pageInfo.endCursor;
    if (!nextCursor) {
      throw new ValidationError(
        "agent-session page cannot continue",
        "Linear returned hasNextPage without endCursor",
      );
    }
    if (seenCursors.has(nextCursor)) {
      throw new ValidationError(
        "agent-session page cursor did not advance",
        "Linear returned the same endCursor on consecutive pages",
      );
    }
    seenCursors.add(nextCursor);
    after = nextCursor;

    if (nodes.length >= limit) break;
  }

  if (nodes.length < limit && rawFetchedCount >= rawScanLimit && pageInfo.hasNextPage) {
    throw new ValidationError(
      `agent-session filtered page scanned the safety cap of ${rawScanLimit} raw sessions before filling ${limit} results`,
      `set LEBOP_MAX_ITEMS=N (where N > ${rawScanLimit}) to raise the ceiling, or pass a tighter filter`,
    );
  }

  return { nodes, pageInfo, searchedCount };
}

async function fetchAgentSessionRawPage(
  client: Awaited<ReturnType<typeof linear>>,
  opts: { first: number; after?: string },
): Promise<AgentSessionConnection> {
  const response = (await withRetry(() =>
    client.client.rawRequest(LIST_ALL_AGENT_SESSIONS_QUERY, {
      first: opts.first,
      after: opts.after,
    }),
  )) as AllSessionsPage;
  return normalizeConnection(response.data.agentSessions);
}

function normalizeConnection(
  connection: AgentSessionConnection | null | undefined,
): AgentSessionConnection {
  if (!connection) return { edges: [], pageInfo: { hasNextPage: false, endCursor: null } };
  return {
    edges: connection.edges,
    pageInfo: {
      hasNextPage: connection.pageInfo.hasNextPage,
      endCursor: connection.pageInfo.endCursor ?? null,
    },
  };
}

function pageSizeFor(input: {
  remaining: number;
  hasClientFilter: boolean;
  rawRemaining: number;
}): number {
  return Math.max(
    1,
    Math.min(
      input.hasClientFilter ? MAX_AGENT_SESSION_PAGE_SIZE : input.remaining,
      MAX_AGENT_SESSION_PAGE_SIZE,
      input.rawRemaining,
    ),
  );
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
      plan
      externalLinks
      activities(first: 50) {
        nodes {
          id
          createdAt
          updatedAt
          ephemeral
          content
        }
      }
    }
  }
`;

interface AgentSessionDetailNode extends AgentSessionNode {
  plan?: unknown;
  externalLinks?: unknown;
  externalUrls?: { label?: string; url: string }[] | null;
  activities?: {
    nodes: {
      id: string;
      createdAt: string;
      updatedAt?: string | null;
      ephemeral?: boolean | null;
      content: Record<string, unknown>;
    }[];
  };
}

export async function getAgentSession(
  id: string,
  opts?: { includeActivities?: boolean },
): Promise<ListedAgentSession | null> {
  // `tryMapToNull` preserves the documented "missing → null" contract while
  // propagating other LebopError subtypes unchanged.
  type Resp = { data: { agentSession: AgentSessionDetailNode | null } };
  const response = await tryMapToNull<Resp>(
    () => withClient((c) => c.client.rawRequest(GET_AGENT_SESSION_QUERY, { id })) as Promise<Resp>,
  );
  if (!response?.data.agentSession) return null;
  const node = response.data.agentSession;
  const base = shape(node);
  const activities =
    opts?.includeActivities === false
      ? undefined
      : (node.activities?.nodes ?? []).map((a) => ({
          id: a.id,
          created_at: a.createdAt,
          updated_at: a.updatedAt ?? null,
          content: a.content ?? {},
          ephemeral: a.ephemeral ?? null,
        }));
  return {
    ...base,
    plan: node.plan ?? undefined,
    external_urls: normalizeExternalLinks(node.externalLinks ?? node.externalUrls),
    ...(activities ? { activities } : {}),
  };
}

function normalizeExternalLinks(value: unknown): { label?: string; url: string }[] | null {
  if (!Array.isArray(value)) return value == null ? null : null;
  const out: { label?: string; url: string }[] = [];
  for (const item of value) {
    if (typeof item === "string" && item) out.push({ url: item });
    else if (
      item &&
      typeof item === "object" &&
      typeof (item as { url?: string }).url === "string"
    ) {
      const rec = item as { url: string; label?: string };
      out.push({ url: rec.url, ...(rec.label ? { label: rec.label } : {}) });
    }
  }
  return out;
}

function agentSessionMatches(session: ListedAgentSession, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    session.id,
    session.status,
    session.type,
    session.issue?.identifier,
    session.issue?.title,
    session.creator?.name,
    session.creator?.email,
  ].some((value) => value?.toLowerCase().includes(needle));
}
