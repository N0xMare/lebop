/**
 * Linear CustomView (saved views) — full CRUD + materialize to issue list.
 */

import { NotFoundError, ValidationError } from "./errors.ts";
import { requireMutationEntity, requireMutationSuccess } from "./mutationResult.ts";
import { withClient } from "./sdk.ts";

export interface CustomViewSummary {
  id: string;
  name: string;
  description: string | null;
  slug_id: string | null;
  shared: boolean;
  model_name: string | null;
}

export interface CustomViewListResult {
  count: number;
  views: CustomViewSummary[];
}

export interface MaterializedViewResult {
  view: CustomViewSummary;
  count: number;
  has_more: boolean;
  next_cursor: string | null;
  issues: {
    identifier: string;
    title: string;
    state: string | null;
    assignee: string | null;
  }[];
}

const LIST_VIEWS = /* GraphQL */ `
  query LebopListCustomViews($first: Int!, $after: String) {
    customViews(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        description
        slugId
        shared
        modelName
      }
    }
  }
`;

const GET_VIEW = /* GraphQL */ `
  query LebopGetCustomView($id: String!) {
    customView(id: $id) {
      id
      name
      description
      slugId
      shared
      modelName
    }
  }
`;

const CREATE_VIEW = /* GraphQL */ `
  mutation LebopCreateCustomView($input: CustomViewCreateInput!) {
    customViewCreate(input: $input) {
      success
      customView {
        id
        name
        description
        slugId
        shared
        modelName
      }
    }
  }
`;

const UPDATE_VIEW = /* GraphQL */ `
  mutation LebopUpdateCustomView($id: String!, $input: CustomViewUpdateInput!) {
    customViewUpdate(id: $id, input: $input) {
      success
      customView {
        id
        name
        description
        slugId
        shared
        modelName
      }
    }
  }
`;

const DELETE_VIEW = /* GraphQL */ `
  mutation LebopDeleteCustomView($id: String!) {
    customViewDelete(id: $id) {
      success
    }
  }
`;

const MATERIALIZE = /* GraphQL */ `
  query LebopMaterializeCustomView($id: String!, $first: Int!, $after: String) {
    customView(id: $id) {
      id
      name
      description
      slugId
      shared
      modelName
      issues(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          identifier
          title
          state {
            name
          }
          assignee {
            name
          }
        }
      }
    }
  }
`;

function shapeView(n: {
  id: string;
  name: string;
  description?: string | null;
  slugId?: string | null;
  shared?: boolean;
  modelName?: string | null;
}): CustomViewSummary {
  return {
    id: n.id,
    name: n.name,
    description: n.description ?? null,
    slug_id: n.slugId ?? null,
    shared: Boolean(n.shared),
    model_name: n.modelName ?? null,
  };
}

export async function listCustomViews(opts?: { limit?: number }): Promise<CustomViewListResult> {
  const first = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const response = (await withClient((c) =>
    c.client.rawRequest(LIST_VIEWS, { first, after: null }),
  )) as {
    data: {
      customViews: {
        nodes: Parameters<typeof shapeView>[0][];
      };
    };
  };
  const views = (response.data.customViews?.nodes ?? []).map(shapeView);
  return { count: views.length, views };
}

export async function getCustomView(id: string): Promise<CustomViewSummary> {
  const response = (await withClient((c) => c.client.rawRequest(GET_VIEW, { id }))) as {
    data: { customView: Parameters<typeof shapeView>[0] | null };
  };
  if (!response.data.customView) {
    throw new NotFoundError(`not found: custom view ${id}`, "pass a view id from list_views");
  }
  return shapeView(response.data.customView);
}

export async function createCustomView(input: {
  name: string;
  description?: string;
  teamId?: string;
  shared?: boolean;
  filterData?: unknown;
}): Promise<CustomViewSummary> {
  if (!input.name?.trim()) {
    throw new ValidationError("view name is required", 'pass --name "My view"');
  }
  const payload: Record<string, unknown> = {
    name: input.name.trim(),
  };
  if (input.description !== undefined) payload.description = input.description;
  if (input.teamId) payload.teamId = input.teamId;
  if (input.shared !== undefined) payload.shared = input.shared;
  if (input.filterData !== undefined) payload.filterData = input.filterData;

  const response = (await withClient((c) =>
    c.client.rawRequest(CREATE_VIEW, { input: payload }),
  )) as {
    data: {
      customViewCreate: {
        success: boolean;
        customView: Parameters<typeof shapeView>[0] | null;
      };
    };
  };
  requireMutationSuccess("customViewCreate", response.data.customViewCreate);
  return shapeView(
    requireMutationEntity(
      "customViewCreate",
      response.data.customViewCreate as { success?: boolean } & Record<string, unknown>,
      "customView",
    ),
  );
}

export async function updateCustomView(
  id: string,
  input: { name?: string; description?: string | null; shared?: boolean; filterData?: unknown },
): Promise<CustomViewSummary> {
  const payload: Record<string, unknown> = {};
  if (input.name !== undefined) payload.name = input.name;
  if (input.description !== undefined) payload.description = input.description;
  if (input.shared !== undefined) payload.shared = input.shared;
  if (input.filterData !== undefined) payload.filterData = input.filterData;
  const response = (await withClient((c) =>
    c.client.rawRequest(UPDATE_VIEW, { id, input: payload }),
  )) as {
    data: {
      customViewUpdate: {
        success: boolean;
        customView: Parameters<typeof shapeView>[0] | null;
      };
    };
  };
  requireMutationSuccess("customViewUpdate", response.data.customViewUpdate);
  return shapeView(
    requireMutationEntity(
      "customViewUpdate",
      response.data.customViewUpdate as { success?: boolean } & Record<string, unknown>,
      "customView",
    ),
  );
}

export async function deleteCustomView(id: string): Promise<boolean> {
  // Pre-flight so re-delete maps through tryIdempotentDelete → already-absent
  // (Linear may return success:true on some soft-delete paths).
  const PREFLIGHT = /* GraphQL */ `
    query LebopCustomViewDeletePreflight($id: String!) {
      customView(id: $id) {
        id
        archivedAt
      }
    }
  `;
  const pre = (await withClient((c) => c.client.rawRequest(PREFLIGHT, { id }))) as {
    data: { customView: { id: string; archivedAt: string | null } | null };
  };
  const row = pre.data.customView;
  if (!row || row.archivedAt !== null) {
    throw new NotFoundError(
      `not found: custom view ${id}`,
      "the view may have already been deleted",
    );
  }
  const response = (await withClient((c) => c.client.rawRequest(DELETE_VIEW, { id }))) as {
    data: { customViewDelete: { success: boolean } };
  };
  requireMutationSuccess("customViewDelete", response.data.customViewDelete);
  return true;
}

export async function materializeCustomView(opts: {
  id: string;
  limit?: number;
  after?: string;
}): Promise<MaterializedViewResult> {
  const first = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const response = (await withClient((c) =>
    c.client.rawRequest(MATERIALIZE, {
      id: opts.id,
      first,
      after: opts.after ?? null,
    }),
  )) as {
    data: {
      customView: {
        id: string;
        name: string;
        description?: string | null;
        slugId?: string | null;
        shared?: boolean;
        modelName?: string | null;
        issues?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            identifier: string;
            title: string;
            state?: { name?: string | null } | null;
            assignee?: { name?: string | null } | null;
          }[];
        } | null;
      } | null;
    };
  };
  const view = response.data.customView;
  if (!view) {
    throw new ValidationError(`not found: custom view ${opts.id}`, "pass a view id");
  }
  const issuesConn = view.issues;
  const issues = (issuesConn?.nodes ?? []).map((n) => ({
    identifier: n.identifier,
    title: n.title,
    state: n.state?.name ?? null,
    assignee: n.assignee?.name ?? null,
  }));
  const hasMore = Boolean(issuesConn?.pageInfo.hasNextPage);
  return {
    view: shapeView(view),
    count: issues.length,
    has_more: hasMore,
    next_cursor: hasMore ? (issuesConn?.pageInfo.endCursor ?? null) : null,
    issues,
  };
}
