/**
 * Label CRUD over Linear's IssueLabel surface.
 *
 * Labels can be team-scoped (have `team.id`) or workspace-scoped (no team).
 * Linear's GraphQL surfaces both via the same `IssueLabel` connection, with
 * `team` nullable.
 */

import { paginateRaw } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedLabel {
  id: string;
  name: string;
  color: string;
  description: string | null;
  team: { id: string; key: string; name: string } | null;
}

export interface ListLabelsOpts {
  /** Team key to scope to. Returns labels in this team OR workspace-scoped. */
  team?: string;
  /** Show workspace-scoped labels only (filters out team-scoped). */
  workspaceOnly?: boolean;
  /** No filter; return everything the token can see. */
  all?: boolean;
  /** Hard cap. Default 10_000 (paginator's safety cap). */
  max?: number;
}

const LIST_LABELS_QUERY = /* GraphQL */ `
  query ListLabels($filter: IssueLabelFilter, $first: Int!, $after: String) {
    issueLabels(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        name
        color
        description
        team { id key name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface LabelsPage {
  data: {
    issueLabels: {
      nodes: ListedLabel[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

export async function listLabels(opts: ListLabelsOpts): Promise<ListedLabel[]> {
  // Build the filter. `team.key.eq` scopes to a team's labels (and Linear
  // includes workspace-scoped labels visible to that team automatically).
  // `workspaceOnly` returns labels whose team is null. `all` = no filter.
  const filter: Record<string, unknown> = {};
  if (opts.team && !opts.all) filter.team = { key: { eq: opts.team } };
  if (opts.workspaceOnly && !opts.all) filter.team = { null: true };

  const client = await linear();
  return paginateRaw<ListedLabel, LabelsPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_LABELS_QUERY, {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first,
        after,
      }) as Promise<LabelsPage>,
    (response) => response.data.issueLabels,
    { pageSize: 250, max: opts.max },
  );
}

export interface CreateLabelInput {
  name: string;
  color?: string;
  description?: string;
  /** Team UUID (NOT key). Resolve via team metadata first. */
  teamId?: string;
}

const CREATE_LABEL_MUTATION = /* GraphQL */ `
  mutation CreateLabel($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel { id name color description team { id key name } }
    }
  }
`;

export async function createLabel(input: CreateLabelInput): Promise<ListedLabel> {
  // NOT wrapped with retry — duplicate creation could result if the first
  // attempt succeeded but the response was lost.
  const client = await linear();
  const response = (await client.client.rawRequest(CREATE_LABEL_MUTATION, { input })) as {
    data: { issueLabelCreate: { success: boolean; issueLabel: ListedLabel } };
  };
  return response.data.issueLabelCreate.issueLabel;
}

const DELETE_LABEL_MUTATION = /* GraphQL */ `
  mutation DeleteLabel($id: String!) {
    issueLabelDelete(id: $id) { success }
  }
`;

export async function deleteLabel(id: string): Promise<boolean> {
  // Delete is NOT wrapped — re-running after first success would surface
  // as "not found" since the label is already gone.
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_LABEL_MUTATION, { id })) as {
    data: { issueLabelDelete: { success: boolean } };
  };
  return response.data.issueLabelDelete.success;
}

/**
 * Resolve a label by name (within an optional team scope) to its UUID.
 * Returns null if no exact-name match. Used by `lebop label delete`.
 */
export async function resolveLabelByName(name: string, team?: string): Promise<ListedLabel | null> {
  // Wrapped read — paginate retries internally; cap at one page since exact
  // match by name should land in the first 250 labels for any sane workspace.
  const labels = await listLabels({ team, max: 250 });
  const lower = name.toLowerCase();
  return labels.find((l) => l.name.toLowerCase() === lower) ?? null;
}

// Re-export for use by `lebop label create` which needs to look up a team
// UUID by key. The list query gives team UUIDs back already.
export { withClient };
