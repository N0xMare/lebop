import { envelope } from "../../lib/envelope.ts";
import { LebopError, ValidationError } from "../../lib/errors.ts";
import { classifyRawGraphQLOperation } from "../../lib/rawGraphql.ts";
import {
  buildRawGraphqlInputFromMcp,
  buildRawGraphqlMcpInputSchema,
  executeRawGraphql,
  type RawGraphqlMcpInput,
  rawGraphqlMcpPayload,
  rawGraphqlOperation,
} from "../../surface/raw.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface RawToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

export function buildRawToolSpecs(deps: RawToolDeps): McpToolSpec[] {
  return [
    {
      name: "raw_graphql",
      config: mcpToolConfig(
        rawGraphqlOperation,
        buildRawGraphqlMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: RawGraphqlMcpInput) => {
        const input = buildRawGraphqlInputFromMcp(args);

        // Confirm mutations before network I/O (behavior freeze).
        if (!args.paginate && classifyRawGraphQLOperation(input.query) === "mutation") {
          // allow_mutation is enforced inside execute; confirm gate here when
          // the document is a mutation so we match legacy order when both fail.
          if (args.allow_mutation === true) {
            deps.requireConfirm(args, "raw_graphql mutation");
          }
        }

        // Map GraphQL syntax and validation errors to the structured taxonomy.
        // Linear's GraphQL endpoint surfaces these as `Syntax Error:`,
        // `Cannot query field`, or `Argument Validation Error` messages; wrap
        // them so clients can branch on a stable error code.
        // Intentional CLI/MCP asymmetry: CLI does not wrap these as ValidationError.
        const wrapGqlErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
          try {
            return await fn();
          } catch (err) {
            if (err instanceof LebopError) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            if (
              /^Syntax Error/.test(msg) ||
              /Cannot query field/.test(msg) ||
              /^Argument Validation Error/.test(msg) ||
              /^Unknown argument/.test(msg) ||
              /^Field .* of type .* must have a selection of subfields/.test(msg)
            ) {
              throw new ValidationError(
                `raw_graphql query failed: ${msg}`,
                "the query is structurally invalid — fix the syntax or schema mismatch and re-send",
              );
            }
            throw err;
          }
        };

        const result = await wrapGqlErrors(() => executeRawGraphql(input));

        // Intentional CLI/MCP asymmetry: MCP always wraps in the standard
        // {schema_version, data} envelope. The CLI's `lebop raw` emits raw
        // `data` for jq-pipe ergonomics (documented in docs/spec.md §15.6).
        return text(envelope(rawGraphqlMcpPayload(result)));
      },
    },
  ];
}
