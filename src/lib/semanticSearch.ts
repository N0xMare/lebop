/**
 * First-class wrap of Linear hybrid/semantic search.
 * Coverage of Linear product search — not a lebop embedding store.
 */

import { ValidationError } from "./errors.ts";
import { withClient } from "./sdk.ts";

export interface SearchHit {
  kind: string;
  id: string;
  identifier: string | null;
  title: string;
  url: string | null;
}

export interface SemanticSearchResult {
  query: string;
  count: number;
  hits: SearchHit[];
  next?: string[];
}

/**
 * Prefer Linear `search` when available; fall back to issue searchableContent.
 */
export async function searchLinear(opts: {
  query: string;
  limit?: number;
  kinds?: string[];
}): Promise<SemanticSearchResult> {
  const query = opts.query?.trim();
  if (!query) {
    throw new ValidationError("search query is required", 'pass --query "text"');
  }
  const first = Math.min(Math.max(opts.limit ?? 20, 1), 50);

  // Try official hybrid search entry if present in schema.
  const SEARCH_QUERY = /* GraphQL */ `
    query LebopSemanticSearch($term: String!, $first: Int!) {
      searchIssues(term: $term, first: $first) {
        nodes {
          id
          identifier
          title
          url
        }
      }
    }
  `;

  try {
    const response = (await withClient((c) =>
      c.client.rawRequest(SEARCH_QUERY, { term: query, first }),
    )) as {
      data: {
        searchIssues?: {
          nodes: { id: string; identifier: string; title: string; url: string }[];
        };
      };
    };
    const nodes = response.data.searchIssues?.nodes ?? [];
    if (nodes.length > 0 || response.data.searchIssues) {
      const hits: SearchHit[] = nodes.map((n) => ({
        kind: "issue",
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        url: n.url,
      }));
      return {
        query,
        count: hits.length,
        hits,
        next: ["show <id>", "workspace fetch /issues/<id>", "list"],
      };
    }
  } catch {
    // Fall through to filter search.
  }

  // Fallback: issues filter searchableContent (always available).
  const FALLBACK = /* GraphQL */ `
    query LebopSearchFallback($filter: IssueFilter, $first: Int!) {
      issues(filter: $filter, first: $first) {
        nodes {
          id
          identifier
          title
          url
        }
      }
    }
  `;
  const response = (await withClient((c) =>
    c.client.rawRequest(FALLBACK, {
      filter: { searchableContent: { contains: query } },
      first,
    }),
  )) as {
    data: {
      issues: { nodes: { id: string; identifier: string; title: string; url: string }[] };
    };
  };
  const hits: SearchHit[] = (response.data.issues?.nodes ?? []).map((n) => ({
    kind: "issue",
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    url: n.url,
  }));
  return {
    query,
    count: hits.length,
    hits,
    next: ["show <id>", "workspace fetch /issues/<id>", "list"],
  };
}
