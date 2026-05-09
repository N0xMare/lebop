import type { Command } from "commander";
import { withClient } from "../lib/sdk.ts";

const SEARCH_DOCUMENTATION_QUERY = /* GraphQL */ `
  query SearchDocumentation($term: String!) {
    searchDocumentation(term: $term) {
      ... on DocumentationSearchPayload {
        nodes {
          title
          url
          excerpt
        }
      }
    }
  }
`;

/**
 * `lebop help-search "query"` — passthrough to Linear's product help search.
 * Useful for "how do I do X in Linear" queries from agents that need to
 * match Linear's documentation conventions.
 *
 * Mirrors the `search_documentation` MCP tool exposed by Linear's hosted
 * MCP server.
 */
export function registerHelpSearch(program: Command): void {
  program
    .command("help-search <term>")
    .description("search Linear's product documentation")
    .option("--json", "emit structured records")
    .action(async (term: string, opts: { json?: boolean }) => {
      const response = (await withClient((c) =>
        c.client.rawRequest(SEARCH_DOCUMENTATION_QUERY, { term }),
      )) as {
        data: {
          searchDocumentation: {
            nodes?: { title: string; url: string; excerpt: string | null }[];
          };
        };
      };
      const nodes = response.data.searchDocumentation.nodes ?? [];

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            { schema_version: 1, term, count: nodes.length, results: nodes },
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (nodes.length === 0) {
        process.stdout.write(`no results for "${term}"\n`);
        return;
      }
      for (const r of nodes) {
        process.stdout.write(`${r.title}\n  ${r.url}\n`);
        if (r.excerpt) process.stdout.write(`  ${r.excerpt}\n`);
        process.stdout.write("\n");
      }
    });
}
