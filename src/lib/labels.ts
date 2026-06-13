/**
 * Label CRUD over Linear's IssueLabel surface.
 *
 * Labels can be team-scoped (have `team.id`) or workspace-scoped (no team).
 * Linear's GraphQL surfaces both via the same `IssueLabel` connection, with
 * `team` nullable.
 */

import { resolveConfig } from "./config.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { requireMutationEntity, requireMutationSuccess } from "./mutationResult.ts";
import { type ConnectionPage, paginateRaw, paginateRawPage } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";
import { getTeam } from "./teams.ts";
import { isUuid } from "./uuid.ts";

export interface ListedLabel {
  id: string;
  name: string;
  color: string;
  description: string | null;
  team: { id: string; key: string; name: string } | null;
}

export type LabelScope = "team" | "workspace";

export interface ListLabelsOpts {
  /** Team key to scope to. Returns labels in this team OR workspace-scoped. */
  team?: string;
  /** Show workspace-scoped labels only (filters out team-scoped). */
  workspaceOnly?: boolean;
  /** No filter; return everything the token can see. */
  all?: boolean;
  /**
   * Hard cap. Defaults to the paginator's runtime safety cap
   * (`LEBOP_MAX_ITEMS` env or 10_000). Pass an explicit value to opt in to a
   * tighter bound without tripping the approaching-cap warning.
   */
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
  const filter = buildLabelFilter(opts);

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

export async function listLabelsPage(
  opts: ListLabelsOpts & {
    limit: number;
    after?: string;
  },
): Promise<ConnectionPage<ListedLabel>> {
  const filter = buildLabelFilter(opts);
  const client = await linear();
  return paginateRawPage<ListedLabel, LabelsPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_LABELS_QUERY, {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first,
        after,
      }) as Promise<LabelsPage>,
    (response) => response.data.issueLabels,
    { limit: opts.limit, after: opts.after, pageSize: 250 },
  );
}

function buildLabelFilter(opts: ListLabelsOpts): Record<string, unknown> {
  // Build the filter:
  //   `--all`              -> no filter (every visible label)
  //   `--workspace-only`   -> labels with no team scope
  //   `--team KEY`         -> labels in this team OR workspace-scoped
  //
  // Linear's IssueLabelFilter applies team filters strictly: `team.key.eq`
  // only returns labels with a non-null team matching the key. To include
  // workspace-scoped labels for a team-scoped query, use `or:`.
  const filter: Record<string, unknown> = {};
  if (opts.all) return filter;
  if (opts.workspaceOnly) {
    filter.team = { null: true };
  } else if (opts.team) {
    filter.or = [{ team: { key: { eq: opts.team } } }, { team: { null: true } }];
  }
  return filter;
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
  return requireMutationEntity<ListedLabel>(
    "issueLabelCreate",
    response.data.issueLabelCreate,
    "issueLabel",
  );
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
  requireMutationSuccess("issueLabelDelete", response.data.issueLabelDelete);
  return true;
}

/**
 * Resolve a label by name (within an optional team scope) to its UUID.
 * Returns null if no exact-name match. Used by `lebop label delete`.
 */
export async function resolveLabelByName(name: string, team?: string): Promise<ListedLabel | null> {
  // Wrapped read — paginate to completion so exact-name matches past Linear's
  // first 250 labels are not reported as absent.
  const labels = await listLabels({ team });
  const lower = name.toLowerCase();
  const matches = labels.filter((l) => l.name.toLowerCase() === lower);
  if (matches.length > 1) {
    const scopes = matches
      .map((label) => (label.team ? `${label.team.key}:${label.id}` : `workspace:${label.id}`))
      .join(", ");
    throw new ValidationError(
      `label name is ambiguous: ${name}`,
      `pass id directly. matches: ${scopes}`,
    );
  }
  return matches[0] ?? null;
}

export async function resolveLabelSelectorToId(
  nameOrId: string,
  scope: LabelScope,
  team: string | undefined,
): Promise<{ id: string; scope: LabelScope; team: string | null; label: ListedLabel | null }> {
  if (isUuid(nameOrId)) return { id: nameOrId, scope, team: team ?? null, label: null };

  let labels: ListedLabel[];
  let resolvedTeam: string | null = null;
  if (scope === "workspace") {
    if (team) {
      throw new ValidationError(
        "scope='workspace' forbids team",
        "drop team, or set scope='team' to delete a team-scoped label",
      );
    }
    labels = await listLabels({ workspaceOnly: true });
  } else {
    const config = await resolveConfig({ teamOverride: team });
    const resolved = await getTeam(config.team);
    if (!resolved) {
      throw new NotFoundError(
        `team not found: ${config.team}`,
        "pass a valid team key, or configure a valid default team",
      );
    }
    resolvedTeam = resolved.key;
    labels = (await listLabels({ team: resolved.key })).filter(
      (label) => label.team?.key === resolved.key,
    );
  }

  const lower = nameOrId.toLowerCase();
  const matches = labels.filter((label) => label.name.toLowerCase() === lower);
  if (matches.length === 0) {
    throw new NotFoundError(
      `label not found: ${nameOrId}`,
      scope === "team"
        ? `check the label name in team ${resolvedTeam ?? team}, or pass the label UUID`
        : "check workspace-scoped labels, or pass the label UUID",
    );
  }
  if (matches.length > 1) {
    const scopes = matches
      .map((label) => (label.team ? `${label.team.key}:${label.id}` : `workspace:${label.id}`))
      .join(", ");
    throw new ValidationError(
      `label name is ambiguous: ${nameOrId}`,
      `pass id directly. matches: ${scopes}`,
    );
  }
  const match = matches[0];
  if (!match) throw new NotFoundError(`label not found: ${nameOrId}`);
  return {
    id: match.id,
    scope: match.team ? "team" : "workspace",
    team: match.team?.key ?? null,
    label: match,
  };
}

// Re-export for use by `lebop label create` which needs to look up a team
// UUID by key. The list query gives team UUIDs back already.
export { withClient };
