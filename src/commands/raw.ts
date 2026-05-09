import type { Command } from "commander";
import { withClient } from "../lib/sdk.ts";

export function registerRaw(program: Command): void {
  program
    .command("raw [query]")
    .description("GraphQL escape hatch — run an arbitrary query/mutation against Linear")
    .option("--variables-json <path>", "read variables from a JSON file ('-' for stdin)")
    .option("--query-file <path>", "read query from a file (use this or positional arg)")
    .action(async (queryArg: string | undefined, opts: RawOpts) => {
      const query = await resolveQuery(queryArg, opts.queryFile);
      const variables = await resolveVariables(opts.variablesJson);

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
  queryFile?: string;
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
