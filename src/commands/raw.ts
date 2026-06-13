import type { Command } from "commander";
import { ValidationError } from "../lib/errors.ts";
import {
  assertRawGraphQLOperationAllowed,
  assertRawGraphQLPaginateAllowed,
} from "../lib/rawGraphql.ts";
import { paginateRawQuery } from "../lib/rawPaginate.ts";
import { linear, withClient } from "../lib/sdk.ts";

export function registerRaw(program: Command): void {
  program
    .command("raw [query]")
    .description("GraphQL escape hatch — run an arbitrary query/mutation against Linear")
    .option("--variables-json <path>", "read variables from a JSON file ('-' for stdin)")
    .option(
      "--variable <k=v>",
      "set one variable; value can be `@filepath` to load from disk, or coerced JSON literal",
      collectVariable,
      {} as Record<string, unknown>,
    )
    .option("--query-file <path>", "read query from a file (use this or positional arg)")
    .option("--paginate", "auto-paginate connections via $first/$after vars + pageInfo discovery")
    .option("--allow-mutation", "allow executing a GraphQL mutation through the raw escape hatch")
    .option("--yes", "confirm GraphQL mutation execution when --allow-mutation is set")
    .option("--confirm", "alias for --yes")
    .action(async (queryArg: string | undefined, opts: RawOpts) => {
      assertSingleStdinSource(queryArg, opts);
      const query = await resolveQuery(queryArg, opts.queryFile);
      const variables = {
        ...(await resolveVariables(opts.variablesJson)),
        ...(await resolveInlineVariables(opts.variable)),
      };

      if (opts.paginate) {
        assertRawGraphQLPaginateAllowed(query);
        const accumulated = await paginateRawQuery(
          variables,
          async (vars) =>
            (await withClient((c) => c.client.rawRequest(query, vars))) as {
              data: Record<string, unknown>;
            },
        );
        process.stdout.write(`${JSON.stringify(accumulated, null, 2)}\n`);
        return;
      }

      const operationKind = assertRawGraphQLOperationAllowed(query, {
        allowMutation: opts.allowMutation === true,
        mutationMessage: "raw GraphQL mutation requires --allow-mutation",
        mutationHint:
          "prefer first-class lebop write tools; if raw mutation is intentional, re-run with --allow-mutation",
        surface: "raw GraphQL",
      });
      if (operationKind === "mutation" && !isConfirmed(opts)) {
        throw new ValidationError(
          "raw GraphQL mutation requires --yes/--confirm with --allow-mutation",
          "prefer first-class lebop write tools; if raw mutation is intentional, pass --yes/--confirm after verifying the mutation and variables",
        );
      }
      const response: unknown =
        operationKind === "mutation"
          ? await (await linear()).client.rawRequest(query, variables)
          : await withClient((c) => c.client.rawRequest(query, variables));

      // rawRequest returns { data, errors?, ... } — unwrap for a clean result view.
      //
      // Intentional CLI/MCP asymmetry: this CLI path emits the RAW data shape
      // (no schema_version envelope) because `lebop raw` is documented as the
      // GraphQL escape hatch and users routinely pipe its output to `jq`
      // expecting the unwrapped Linear GraphQL response. The MCP analog
      // (`raw_graphql` tool) wraps `{schema_version, data}` because tool-call
      // responses must always carry the envelope. See docs/spec.md §15.6.
      const payload = (response as { data?: unknown }).data ?? response;
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    });
}

function assertSingleStdinSource(queryArg: string | undefined, opts: RawOpts): void {
  if (opts.variablesJson !== "-") return;
  const queryFromStdin = queryArg === "-" || (!queryArg && !opts.queryFile && !process.stdin.isTTY);
  if (!queryFromStdin) return;
  throw new ValidationError(
    "raw cannot read both query and --variables-json from stdin",
    "pass the query as a positional argument or --query-file when using --variables-json -, or pass variables from a file",
  );
}

interface RawOpts {
  variablesJson?: string;
  variable?: Record<string, unknown>;
  queryFile?: string;
  paginate?: boolean;
  allowMutation?: boolean;
  yes?: boolean;
  confirm?: boolean;
}

async function resolveQuery(arg: string | undefined, file: string | undefined): Promise<string> {
  if (arg && arg !== "-") return arg;
  if (file) return (await Bun.file(file).text()).trim();
  if (arg === "-" || !process.stdin.isTTY) {
    return (await Bun.stdin.text()).trim();
  }
  throw new ValidationError(
    "no query provided. pass it as a positional arg, --query-file, or on stdin",
    "pass a query string, --query-file <path>, or pipe the query on stdin",
  );
}

async function resolveVariables(path: string | undefined): Promise<Record<string, unknown>> {
  if (!path) return {};
  const text = path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(
      "--variables-json must contain a JSON object",
      'provide a JSON object such as {"id":"NOX-1"}',
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve `--variable k=v` entries. Values are interpreted in this order:
 *   - `@path` → read file contents as the value (string)
 *   - JSON literal that parses (numbers, booleans, null, objects, arrays)
 *   - fallback: string as-is
 */
async function resolveInlineVariables(
  raw: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    if (v.startsWith("@")) {
      // File-backed value
      out[k] = await Bun.file(v.slice(1)).text();
      continue;
    }
    // Try JSON-parse for type coercion (numbers, booleans, null, objects).
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function collectVariable(
  value: string,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const eq = value.indexOf("=");
  if (eq === -1) {
    throw new ValidationError(
      `--variable must be of form k=v (got "${value}")`,
      "use --variable key=value",
    );
  }
  const key = value.slice(0, eq);
  const raw = value.slice(eq + 1);
  return { ...previous, [key]: raw };
}

function isConfirmed(opts: Pick<RawOpts, "yes" | "confirm">): boolean {
  return opts.yes === true || opts.confirm === true;
}
