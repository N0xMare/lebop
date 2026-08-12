/**
 * Issue field-changelog history (Linear IssueHistory).
 * Dense control-plane read — not comments, not agent activities.
 */

import { ValidationError } from "./errors.ts";
import { withClient } from "./sdk.ts";

export interface IssueHistoryRow {
  at: string;
  actor: string | null;
  kind: string;
  from: string | null;
  to: string | null;
}

export interface IssueHistoryResult {
  identifier: string;
  count: number;
  has_more: boolean;
  next_cursor: string | null;
  truncated: boolean;
  history: IssueHistoryRow[];
  next?: string[];
}

const HISTORY_QUERY = /* GraphQL */ `
  query IssueHistory($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      id
      identifier
      history(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          createdAt
          updatedAt
          fromTitle
          toTitle
          fromPriority
          toPriority
          fromEstimate
          toEstimate
          fromDueDate
          toDueDate
          actor {
            name
            email
          }
          fromState {
            name
          }
          toState {
            name
          }
          fromAssignee {
            name
          }
          toAssignee {
            name
          }
          fromProject {
            name
          }
          toProject {
            name
          }
          fromCycle {
            name
          }
          toCycle {
            name
          }
          addedLabelIds
          removedLabelIds
        }
      }
    }
  }
`;

interface HistoryNode {
  id: string;
  createdAt: string;
  updatedAt?: string;
  fromTitle?: string | null;
  toTitle?: string | null;
  fromPriority?: number | null;
  toPriority?: number | null;
  fromEstimate?: number | null;
  toEstimate?: number | null;
  fromDueDate?: string | null;
  toDueDate?: string | null;
  actor?: { name?: string | null; email?: string | null } | null;
  fromState?: { name?: string | null } | null;
  toState?: { name?: string | null } | null;
  fromAssignee?: { name?: string | null } | null;
  toAssignee?: { name?: string | null } | null;
  fromProject?: { name?: string | null } | null;
  toProject?: { name?: string | null } | null;
  fromCycle?: { name?: string | null } | null;
  toCycle?: { name?: string | null } | null;
  addedLabelIds?: string[] | null;
  removedLabelIds?: string[] | null;
}

/**
 * Flatten a Linear history node into zero or more dense change rows.
 * Pure function — unit-tested without network.
 */
export function shapeHistoryNode(node: HistoryNode): IssueHistoryRow[] {
  const at = node.createdAt;
  const actor = node.actor?.name ?? node.actor?.email ?? null;
  const rows: IssueHistoryRow[] = [];
  const push = (kind: string, from: string | null | undefined, to: string | null | undefined) => {
    if (from == null && to == null) return;
    if (from === to) return;
    rows.push({
      at,
      actor,
      kind,
      from: from == null ? null : String(from),
      to: to == null ? null : String(to),
    });
  };
  push("title", node.fromTitle, node.toTitle);
  push(
    "priority",
    node.fromPriority == null ? null : String(node.fromPriority),
    node.toPriority == null ? null : String(node.toPriority),
  );
  push(
    "estimate",
    node.fromEstimate == null ? null : String(node.fromEstimate),
    node.toEstimate == null ? null : String(node.toEstimate),
  );
  push("due_date", node.fromDueDate, node.toDueDate);
  push("state", node.fromState?.name, node.toState?.name);
  push("assignee", node.fromAssignee?.name, node.toAssignee?.name);
  push("project", node.fromProject?.name, node.toProject?.name);
  push("cycle", node.fromCycle?.name, node.toCycle?.name);
  if (node.addedLabelIds?.length || node.removedLabelIds?.length) {
    rows.push({
      at,
      actor,
      kind: "labels",
      from: node.removedLabelIds?.length ? `-${node.removedLabelIds.length}` : null,
      to: node.addedLabelIds?.length ? `+${node.addedLabelIds.length}` : null,
    });
  }
  if (rows.length === 0) {
    rows.push({ at, actor, kind: "change", from: null, to: null });
  }
  return rows;
}

export async function listIssueHistory(opts: {
  identifier: string;
  limit?: number;
  after?: string;
  since?: string;
}): Promise<IssueHistoryResult> {
  const identifier = opts.identifier.trim();
  if (!identifier) {
    throw new ValidationError("issue identifier is required", "pass TEAM-123 or an issue UUID");
  }
  const first = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const response = (await withClient((c) =>
    c.client.rawRequest(HISTORY_QUERY, {
      id: identifier,
      first,
      after: opts.after ?? null,
    }),
  )) as {
    data: {
      issue: {
        identifier: string;
        history: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: HistoryNode[];
        };
      } | null;
    };
  };
  const issue = response.data.issue;
  if (!issue) {
    throw new ValidationError(`not found: ${identifier}`, "check the issue identifier");
  }
  let history = issue.history.nodes.flatMap(shapeHistoryNode);
  if (opts.since) {
    const sinceMs = Date.parse(opts.since);
    if (!Number.isNaN(sinceMs)) {
      history = history.filter((row) => Date.parse(row.at) >= sinceMs);
    }
  }
  const hasMore = issue.history.pageInfo.hasNextPage;
  return {
    identifier: issue.identifier,
    count: history.length,
    has_more: hasMore,
    next_cursor: hasMore ? issue.history.pageInfo.endCursor : null,
    truncated: hasMore,
    history,
    next: ["show <id>", "comment list <id>"],
  };
}
