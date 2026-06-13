import { ValidationError } from "./errors.ts";
import { normalizeIssueIdentifier } from "./issueIdentifiers.ts";
import { ISSUE_FIELDS_FRAGMENT } from "./pullQuery.ts";
import { withClient } from "./sdk.ts";
import { isUuid } from "./uuid.ts";

export const ISSUE_UPDATE_MUTATION = /* GraphQL */ `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        ...IssueFields
      }
    }
  }
  ${ISSUE_FIELDS_FRAGMENT}
`;

export const PROJECT_UPDATE_MUTATION = /* GraphQL */ `
  mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
      project {
        id
        name
        description
        content
        icon
        state
        startDate
        targetDate
        url
        updatedAt
      }
    }
  }
`;

export const CAS_QUERY_BATCH_SIZE = 100;

export interface IssueCasState {
  id: string;
  identifier: string;
  updatedAt: string;
}

export interface ProjectCasState {
  id: string;
  updatedAt: string;
}

/**
 * Batched `updatedAt` fetch for stale guards.
 * Returns a query string with one alias per identifier.
 *
 * Throws on empty `identifiers` — an empty selection set returns an invalid
 * GraphQL document that Linear rejects.
 */
export function buildCasQuery(identifiers: string[]): string {
  if (identifiers.length === 0) {
    throw new ValidationError(
      "buildCasQuery: cannot build a query with zero identifiers",
      "pass at least one TEAM-NN identifier to the stale-guard fetch",
    );
  }
  const aliases = identifiers
    .map((id, i) => {
      const identifier = normalizeIssueIdentifier(id);
      return `  a${i}: issue(id: "${identifier}") { id identifier updatedAt }`;
    })
    .join("\n");
  return `query CasFetch {\n${aliases}\n}`;
}

/**
 * Batched project `updatedAt` fetch for stale guards.
 * Returns a query string with one alias per project UUID.
 */
export function buildProjectCasQuery(projectIds: string[]): string {
  if (projectIds.length === 0) {
    throw new ValidationError(
      "buildProjectCasQuery: cannot build a query with zero project ids",
      "pass at least one project UUID to the stale-guard fetch",
    );
  }
  const aliases = projectIds
    .map((id, i) => {
      if (!isUuid(id)) {
        throw new ValidationError(`invalid project id: ${id}`, "project ids must be UUIDs");
      }
      return `  p${i}: project(id: "${id}") { id updatedAt }`;
    })
    .join("\n");
  return `query ProjectCasFetch {\n${aliases}\n}`;
}

export async function fetchIssueCasStates(
  identifiers: string[],
): Promise<Record<string, IssueCasState | null>> {
  const result: Record<string, IssueCasState | null> = {};
  for (const batch of chunkCasInputs(identifiers)) {
    const response = (await withClient((c) => c.client.rawRequest(buildCasQuery(batch)))) as {
      data: Record<string, IssueCasState | null>;
    };
    batch.forEach((identifier, i) => {
      result[identifier] = response.data[`a${i}`] ?? null;
    });
  }
  return result;
}

export async function fetchProjectCasStates(
  projectIds: string[],
): Promise<Record<string, ProjectCasState | null>> {
  const result: Record<string, ProjectCasState | null> = {};
  for (const batch of chunkCasInputs(projectIds)) {
    const response = (await withClient((c) =>
      c.client.rawRequest(buildProjectCasQuery(batch)),
    )) as {
      data: Record<string, ProjectCasState | null>;
    };
    batch.forEach((id, i) => {
      result[id] = response.data[`p${i}`] ?? null;
    });
  }
  return result;
}

export function chunkCasInputs<T>(values: T[], size = CAS_QUERY_BATCH_SIZE): T[][] {
  if (values.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

export interface IssueUpdateInput {
  title?: string;
  description?: string;
  stateId?: string;
  priority?: number;
  estimate?: number | null;
  labelIds?: string[];
  assigneeId?: string | null;
  parentId?: string | null;
  projectId?: string | null;
  projectMilestoneId?: string | null;
  cycleId?: string | null;
}

export interface ProjectUpdateInput {
  name?: string;
  description?: string;
  content?: string;
  icon?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  state?: string;
}
