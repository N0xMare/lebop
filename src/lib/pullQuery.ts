export const ISSUE_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment IssueFields on Issue {
    id
    identifier
    title
    description
    priority
    estimate
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
    parent {
      id
      identifier
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
    comments(first: 250) {
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
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const RELATIONS_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment RelationFields on Issue {
    relations {
      nodes {
        id
        type
        relatedIssue { id identifier title }
      }
    }
    inverseRelations {
      nodes {
        id
        type
        issue { id identifier title }
      }
    }
  }
`;

/**
 * Linear's IssueFilter doesn't expose `identifier`, but `issue(id: ...)` accepts either
 * a UUID or a TEAM-NN identifier. Multi-alias query = one HTTP round-trip for N issues.
 */
export function buildPullIssuesQuery(
  identifiers: string[],
  withComments: boolean,
  withRelations = false,
): string {
  const fragments = ["...IssueFields"];
  if (withComments) fragments.push("...CommentFields");
  if (withRelations) fragments.push("...RelationFields");
  const spread = fragments.join(" ");

  const aliases = identifiers
    .map((id, i) => {
      if (!/^[A-Z]+-\d+$/.test(id)) {
        throw new Error(`invalid issue identifier: ${id}`);
      }
      return `  a${i}: issue(id: "${id}") { ${spread} }`;
    })
    .join("\n");
  return `
    query PullIssues {
    ${aliases}
    }
    ${ISSUE_FIELDS_FRAGMENT}
    ${withComments ? COMMENTS_FIELDS_FRAGMENT : ""}
    ${withRelations ? RELATIONS_FIELDS_FRAGMENT : ""}
  `;
}

/**
 * Continuation comments fetch for any issue whose multi-alias `comments`
 * fragment hit the 250-per-page cap. Use with `paginateRaw` and
 * `initialAfter` set to the original `pageInfo.endCursor`.
 */
export const MORE_COMMENTS_QUERY = /* GraphQL */ `
  query MoreComments($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      comments(first: $first, after: $after) {
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
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

/**
 * Project header (no issues sub-list). Pair with `PULL_PROJECT_ISSUES_QUERY`
 * to walk all child issues regardless of count.
 */
export const PULL_PROJECT_HEADER_QUERY = /* GraphQL */ `
  query PullProjectHeader($id: String!) {
    project(id: $id) {
      id
      name
      description
      content
      state
      url
      updatedAt
    }
  }
`;

/**
 * Paginated issues-in-a-project query. Use with `paginateRaw` and a
 * `pageSize` ≤ 250 (Linear's per-request maximum).
 */
export const PULL_PROJECT_ISSUES_QUERY = /* GraphQL */ `
  query PullProjectIssues($id: String!, $first: Int!, $after: String) {
    project(id: $id) {
      issues(first: $first, after: $after) {
        nodes {
          identifier
          title
        }
        pageInfo {
          hasNextPage
          endCursor
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
  estimate: number | null;
  url: string;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  assignee: { id: string; name: string; email: string } | null;
  project: { id: string; name: string } | null;
  team: { id: string; key: string };
  parent: { id: string; identifier: string } | null;
  labels: { nodes: { id: string; name: string }[] };
  comments?: {
    nodes: {
      id: string;
      body: string;
      createdAt: string;
      updatedAt: string;
      user: { id: string; name: string; email: string } | null;
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
  relations?: {
    nodes: {
      id: string;
      type: "blocks" | "duplicate" | "related" | "similar";
      relatedIssue: { id: string; identifier: string; title: string };
    }[];
  };
  inverseRelations?: {
    nodes: {
      id: string;
      type: "blocks" | "duplicate" | "related" | "similar";
      issue: { id: string; identifier: string; title: string };
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
  /** Populated by callers after paginating PULL_PROJECT_ISSUES_QUERY. */
  issues: { nodes: { identifier: string; title?: string }[] };
}
