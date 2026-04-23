export const ISSUE_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment IssueFields on Issue {
    id
    identifier
    title
    description
    priority
    url
    updatedAt
    state {
      id
      name
      type
    }
    assignee {
      id
      name
      email
    }
    project {
      id
      name
    }
    team {
      id
      key
    }
    labels {
      nodes {
        id
        name
      }
    }
  }
`;

export const COMMENTS_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment CommentFields on Issue {
    comments(first: 100) {
      nodes {
        id
        body
        createdAt
        updatedAt
        user {
          id
          name
          email
        }
      }
    }
  }
`;

/**
 * Linear's IssueFilter doesn't expose `identifier`, but `issue(id: ...)` accepts either
 * a UUID or a TEAM-NN identifier. Multi-alias query = one HTTP round-trip for N issues.
 */
export function buildPullIssuesQuery(identifiers: string[], withComments: boolean): string {
  const aliases = identifiers
    .map((id, i) => {
      if (!/^[A-Z]+-\d+$/.test(id)) {
        throw new Error(`invalid issue identifier: ${id}`);
      }
      return `  a${i}: issue(id: "${id}") { ...IssueFields${withComments ? " ...CommentFields" : ""} }`;
    })
    .join("\n");
  return `
    query PullIssues {
    ${aliases}
    }
    ${ISSUE_FIELDS_FRAGMENT}
    ${withComments ? COMMENTS_FIELDS_FRAGMENT : ""}
  `;
}

export const PULL_PROJECT_QUERY = /* GraphQL */ `
  query PullProject($id: String!) {
    project(id: $id) {
      id
      name
      description
      content
      state
      url
      updatedAt
      issues(first: 250) {
        nodes {
          identifier
        }
      }
    }
  }
`;

export interface FetchedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  url: string;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  assignee: { id: string; name: string; email: string } | null;
  project: { id: string; name: string } | null;
  team: { id: string; key: string };
  labels: { nodes: { id: string; name: string }[] };
  comments?: {
    nodes: {
      id: string;
      body: string;
      createdAt: string;
      updatedAt: string;
      user: { id: string; name: string; email: string } | null;
    }[];
  };
}

export interface FetchedProject {
  id: string;
  name: string;
  description: string;
  content: string | null;
  state: string;
  url: string;
  updatedAt: string;
  issues: { nodes: { identifier: string }[] };
}
