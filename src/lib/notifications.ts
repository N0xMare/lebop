/**
 * Notifications inbox read surface (Linear notifications connection).
 */

import { withClient } from "./sdk.ts";

export interface ListedNotification {
  id: string;
  type: string | null;
  read_at: string | null;
  created_at: string;
  issue: { id: string; identifier: string; title: string } | null;
}

export interface NotificationsResult {
  count: number;
  has_more: boolean;
  next_cursor: string | null;
  notifications: ListedNotification[];
}

const LIST_NOTIFICATIONS = /* GraphQL */ `
  query LebopNotifications($first: Int!, $after: String) {
    notifications(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        type
        readAt
        createdAt
        issue {
          id
          identifier
          title
        }
      }
    }
  }
`;

export async function listNotifications(opts?: {
  limit?: number;
  after?: string;
}): Promise<NotificationsResult> {
  const first = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  try {
    const response = (await withClient((c) =>
      c.client.rawRequest(LIST_NOTIFICATIONS, {
        first,
        after: opts?.after ?? null,
      }),
    )) as {
      data: {
        notifications: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            id: string;
            type?: string | null;
            readAt?: string | null;
            createdAt: string;
            issue?: { id: string; identifier: string; title: string } | null;
          }[];
        };
      };
    };
    const conn = response.data.notifications;
    const notifications: ListedNotification[] = (conn?.nodes ?? []).map((n) => ({
      id: n.id,
      type: n.type ?? null,
      read_at: n.readAt ?? null,
      created_at: n.createdAt,
      issue: n.issue ?? null,
    }));
    const hasMore = Boolean(conn?.pageInfo.hasNextPage);
    return {
      count: notifications.length,
      has_more: hasMore,
      next_cursor: hasMore ? (conn?.pageInfo.endCursor ?? null) : null,
      notifications,
    };
  } catch (err) {
    // API shape may vary; return empty with note via throw for callers.
    throw err;
  }
}
