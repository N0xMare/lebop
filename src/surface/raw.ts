import { z } from "zod";
import {
  assertRawGraphQLOperationAllowed,
  assertRawGraphQLPaginateAllowed,
  type RawGraphQLOperationKind,
} from "../lib/rawGraphql.ts";
import { paginateRawQuery } from "../lib/rawPaginate.ts";
import { linear, withClient } from "../lib/sdk.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

// ---------------------------------------------------------------------------
// Canonical inputs / results
// ---------------------------------------------------------------------------

export interface RawGraphqlInput {
  query: string;
  variables: Record<string, unknown>;
  paginate?: boolean;
  allowMutation?: boolean;
  workspace?: string;
  /** Channel-specific allow-mutation messaging (behavior freeze). */
  mutationMessage: string;
  mutationHint: string;
  surfaceLabel: string;
}

export interface RawGraphqlCliInput {
  query: string;
  variables?: Record<string, unknown>;
  paginate?: boolean;
  allowMutation?: boolean;
}

export type RawGraphqlMcpInput = Record<string, unknown> & {
  query: string;
  variables?: Record<string, unknown>;
  paginate?: boolean;
  allow_mutation?: boolean;
  confirm?: boolean;
  workspace?: string;
};

export interface RawGraphqlResult {
  /** Unwrapped Linear `data` payload (or paginated merge). */
  data: unknown;
  operationKind: RawGraphQLOperationKind;
  paginated: boolean;
}

const rawGraphqlCanonicalSchema = z
  .object({
    query: z.string().min(1),
    variables: z.record(z.string(), z.unknown()).default({}),
    paginate: z.boolean().optional(),
    allowMutation: z.boolean().optional(),
    workspace: z.string().optional(),
    mutationMessage: z.string().min(1),
    mutationHint: z.string().min(1),
    surfaceLabel: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildRawGraphqlInputFromCli(input: RawGraphqlCliInput): RawGraphqlInput {
  return parseSurfaceInput("raw.graphql", rawGraphqlCanonicalSchema, {
    query: input.query,
    variables: input.variables ?? {},
    paginate: input.paginate,
    allowMutation: input.allowMutation,
    mutationMessage: "raw GraphQL mutation requires --allow-mutation",
    mutationHint:
      "prefer first-class lebop write tools; if raw mutation is intentional, re-run with --allow-mutation",
    surfaceLabel: "raw GraphQL",
  });
}

export function buildRawGraphqlInputFromMcp(input: RawGraphqlMcpInput): RawGraphqlInput {
  return parseSurfaceInput("raw.graphql", rawGraphqlCanonicalSchema, {
    query: input.query,
    variables: input.variables ?? {},
    paginate: input.paginate,
    allowMutation: input.allow_mutation === true,
    workspace: input.workspace,
    mutationMessage: "raw_graphql mutation requires allow_mutation=true",
    mutationHint:
      "prefer first-class lebop write tools; if raw mutation is intentional, re-send with allow_mutation:true",
    surfaceLabel: "raw_graphql",
  });
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function executeRawGraphql(input: RawGraphqlInput): Promise<RawGraphqlResult> {
  const query = input.query;
  const variables = input.variables;
  const workspace = input.workspace;

  if (input.paginate) {
    assertRawGraphQLPaginateAllowed(query);
    const accumulated = await paginateRawQuery(
      variables,
      async (vars) =>
        (await withClient((c) => c.client.rawRequest(query, vars), workspace)) as {
          data: Record<string, unknown>;
        },
    );
    return {
      data: accumulated,
      operationKind: "query",
      paginated: true,
    };
  }

  const operationKind = assertRawGraphQLOperationAllowed(query, {
    allowMutation: input.allowMutation === true,
    mutationMessage: input.mutationMessage,
    mutationHint: input.mutationHint,
    surface: input.surfaceLabel,
  });

  const response: unknown =
    operationKind === "mutation"
      ? await (await linear(workspace)).client.rawRequest(query, variables)
      : await withClient((c) => c.client.rawRequest(query, variables), workspace);

  // rawRequest returns { data, errors?, ... } — unwrap for a clean result view.
  const data = (response as { data?: unknown }).data ?? response;
  return {
    data,
    operationKind,
    paginated: false,
  };
}

/**
 * CLI emits unwrapped Linear data for jq-pipe ergonomics (docs/spec.md §15.6).
 * Do **not** wrap with the schema_version envelope.
 */
export function rawGraphqlCliPayload(result: RawGraphqlResult): unknown {
  return result.data;
}

/**
 * MCP always wraps `{ schema_version, data }` via envelope({ data }) — the
 * adapter applies `envelope`; this returns the inner object only.
 */
export function rawGraphqlMcpPayload(result: RawGraphqlResult) {
  return { data: result.data };
}

// ---------------------------------------------------------------------------
// MCP schema + operation
// ---------------------------------------------------------------------------

const rawGraphqlDescription =
  "Executes arbitrary Linear GraphQL. Use only when no first-class tool covers the operation. Queries run directly; mutations require allow_mutation=true and confirm=true and are never retry-wrapped. Returns `{schema_version, data}` (the standard MCP envelope wrapping Linear's raw response.data). Pass paginate=true to walk a top-level connection. The matching CLI tool `lebop raw` intentionally emits unwrapped `data` (no envelope) for jq-pipe ergonomics; see docs/spec.md §15.6.";

export function buildRawGraphqlMcpInputSchema(workspaceDescription: string) {
  return {
    query: z.string().describe("GraphQL document (query or mutation)."),
    variables: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Variables object for the query."),
    paginate: z
      .boolean()
      .optional()
      .describe(
        "If the query has a top-level connection, walks pageInfo.hasNextPage and merges nodes.",
      ),
    allow_mutation: z
      .boolean()
      .optional()
      .describe("Required true to execute GraphQL mutation operations."),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Required true when executing a GraphQL mutation because raw mutations bypass first-class review/validation.",
      ),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export const rawGraphqlOperation = {
  id: "raw.graphql",
  domain: "raw",
  resource: "graphql",
  action: "other",
  title: "GraphQL escape hatch — execute an arbitrary query/mutation",
  description: rawGraphqlDescription,
  cli: {
    command: "raw",
    liveSteps: ["cli:raw", "cli:raw query-file"],
  },
  mcp: {
    tool: "raw_graphql",
    title: "GraphQL escape hatch — execute an arbitrary query/mutation",
    description: rawGraphqlDescription,
    annotations: {
      title: "GraphQL escape hatch — execute an arbitrary query/mutation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaKeys: ["query", "variables", "paginate", "allow_mutation", "confirm", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  notes:
    "Intentional CLI/MCP envelope asymmetry: CLI emits unwrapped data; MCP wraps {schema_version, data}. Mutation confirm stays in adapters. GraphQL syntax ValidationError wrapping is MCP-only.",
  fromCli: buildRawGraphqlInputFromCli,
  fromMcp: buildRawGraphqlInputFromMcp,
  execute: executeRawGraphql,
} satisfies SurfaceOperationContract<
  RawGraphqlInput,
  RawGraphqlResult,
  RawGraphqlCliInput,
  RawGraphqlMcpInput
>;

export const RAW_SURFACE_OPERATIONS = [rawGraphqlOperation] as const;
