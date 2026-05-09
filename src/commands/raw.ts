import type { Command } from "commander";
import { withClient } from "../lib/sdk.ts";

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
    .action(async (queryArg: string | undefined, opts: RawOpts) => {
      const query = await resolveQuery(queryArg, opts.queryFile);
      const variables = {
        ...(await resolveVariables(opts.variablesJson)),
        ...(await resolveInlineVariables(opts.variable)),
      };

      if (opts.paginate) {
        const accumulated = await paginateRaw(query, variables);
        process.stdout.write(`${JSON.stringify(accumulated, null, 2)}\n`);
        return;
      }

      // `raw` queries are caller-defined; they may be reads or mutations. Wrap
      // with retry under the assumption that callers passing creates accept
      // the duplicate-on-retry-after-success risk (the escape hatch contract).
      const response: unknown = await withClient((c) => c.client.rawRequest(query, variables));

      // rawRequest returns { data, errors?, ... } — unwrap for a clean result view.
      const payload = (response as { data?: unknown }).data ?? response;
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    });
}

interface RawOpts {
  variablesJson?: string;
  variable?: Record<string, unknown>;
  queryFile?: string;
  paginate?: boolean;
}

async function resolveQuery(arg: string | undefined, file: string | undefined): Promise<string> {
  if (arg && arg !== "-") return arg;
  if (file) return (await Bun.file(file).text()).trim();
  if (arg === "-" || !process.stdin.isTTY) {
    return (await Bun.stdin.text()).trim();
  }
  throw new Error("no query provided. pass it as a positional arg, --query-file, or on stdin");
}

async function resolveVariables(path: string | undefined): Promise<Record<string, unknown>> {
  if (!path) return {};
  const text = path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("--variables-json must contain a JSON object");
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
    throw new Error(`--variable must be of form k=v (got "${value}")`);
  }
  const key = value.slice(0, eq);
  const raw = value.slice(eq + 1);
  return { ...previous, [key]: raw };
}

/**
 * Auto-paginate any GraphQL query that exposes one connection-shaped field
 * with `$first` + `$after` variables. Walks until the first connection's
 * pageInfo.hasNextPage goes false, accumulates all `nodes`, and returns
 * the merged result.
 *
 * Works for queries shaped like:
 *   query Foo($first: Int!, $after: String) {
 *     someConnection(first: $first, after: $after) {
 *       nodes { ... }
 *       pageInfo { hasNextPage endCursor }
 *     }
 *   }
 *
 * Heuristic: scans the response's top-level `data.*` fields for one with
 * `nodes` + `pageInfo`. If multiple match, pages the first one found.
 */
async function paginateRaw(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const pageSize = (variables.first as number | undefined) ?? 250;
  let after: string | undefined = variables.after as string | undefined;
  const allNodes: unknown[] = [];
  let lastResponse: Record<string, unknown> | null = null;
  let connectionKey: string | null = null;

  while (true) {
    const vars = { ...variables, first: pageSize, after };
    const response = (await withClient((c) => c.client.rawRequest(query, vars))) as {
      data: Record<string, unknown>;
    };
    lastResponse = response.data;

    // Find the first connection-shaped field on the first iteration.
    if (!connectionKey) {
      for (const [k, v] of Object.entries(response.data)) {
        if (isConnection(v)) {
          connectionKey = k;
          break;
        }
      }
      if (!connectionKey) {
        throw new Error(
          "--paginate: no connection-shaped field found on the response. expected a top-level `data.X` with both `nodes` and `pageInfo`.",
        );
      }
    }

    const conn = response.data[connectionKey] as {
      nodes: unknown[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
    allNodes.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }

  // Return the last response with the merged nodes substituted in.
  if (lastResponse && connectionKey) {
    const merged = {
      ...lastResponse,
      [connectionKey]: {
        ...(lastResponse[connectionKey] as object),
        nodes: allNodes,
      },
    };
    return merged;
  }
  return lastResponse;
}

function isConnection(value: unknown): value is { nodes: unknown[]; pageInfo: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.nodes) && typeof v.pageInfo === "object" && v.pageInfo !== null;
}
