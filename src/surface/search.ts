/**
 * Search surface — hybrid/semantic Linear search.
 */

import { z } from "zod";
import { parseCliLimit } from "../lib/cliOptions.ts";
import { type SemanticSearchResult, searchLinear } from "../lib/semanticSearch.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

// ── Search ──────────────────────────────────────────────────────────────────

export interface SearchLinearInput {
  query: string;
  limit: number;
}

export interface SearchLinearCliInput {
  opts: { query: string; limit?: string };
}

export type SearchLinearMcpInput = Record<string, unknown> & {
  query: string;
  limit?: number;
};

const searchLinearCanonicalSchema = z
  .object({
    query: z.string(),
    limit: z.number().int().positive(),
  })
  .strict();

export function buildSearchLinearInputFromCli(input: SearchLinearCliInput): SearchLinearInput {
  return parseSurfaceInput("search.linear", searchLinearCanonicalSchema, {
    query: input.opts.query,
    limit: parseCliLimit(input.opts.limit, { defaultValue: 20 }),
  });
}

export function buildSearchLinearInputFromMcp(input: SearchLinearMcpInput): SearchLinearInput {
  return parseSurfaceInput("search.linear", searchLinearCanonicalSchema, {
    query: input.query,
    limit: input.limit ?? 20,
  });
}

export async function executeSearchLinear(input: SearchLinearInput): Promise<SemanticSearchResult> {
  return searchLinear({ query: input.query, limit: input.limit });
}

export const searchLinearOperation = {
  id: "search.linear",
  domain: "search",
  resource: "search",
  action: "list",
  title: "Search Linear",
  description: "Hybrid/semantic Linear search (keyword fallback). Returns dense hits for issues.",
  cli: {
    command: "search",
    liveSteps: ["cli:search --json"],
  },
  mcp: {
    tool: "search_linear",
      profile: "core",
    title: "Search Linear",
    description: "Hybrid/semantic Linear search (keyword fallback). Returns dense hits for issues.",
    annotations: {
      title: "Search Linear",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildSearchLinearInputFromCli,
  fromMcp: buildSearchLinearInputFromMcp,
  execute: executeSearchLinear,
} satisfies SurfaceOperationContract<
  SearchLinearInput,
  SemanticSearchResult,
  SearchLinearCliInput,
  SearchLinearMcpInput
>;

export function buildSearchLinearMcpInputSchema(workspaceDescription: string) {
  return {
    query: z.string(),
    limit: z.number().int().min(1).max(50).optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}
