import { ISSUE_FIELDS_FRAGMENT } from "./pullQuery.ts";

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
        state
        url
        updatedAt
      }
    }
  }
`;

/**
 * Batched `updatedAt` fetch for CAS.
 * Returns a query string with one alias per identifier.
 *
 * Throws on empty `identifiers` — an empty selection set returns an invalid
 * GraphQL document that Linear rejects.
 */
export function buildCasQuery(identifiers: string[]): string {
  if (identifiers.length === 0) {
    throw new Error("buildCasQuery: cannot build a query with zero identifiers");
  }
  const aliases = identifiers
    .map((id, i) => {
      if (!/^[A-Z]+-\d+$/.test(id)) throw new Error(`invalid identifier: ${id}`);
      return `  a${i}: issue(id: "${id}") { id identifier updatedAt }`;
    })
    .join("\n");
  return `query CasFetch {\n${aliases}\n}`;
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
}

export interface ProjectUpdateInput {
  name?: string;
  description?: string;
  content?: string;
  state?: string;
}
