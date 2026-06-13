import { ValidationError } from "./errors.ts";

export type RawGraphQLOperationKind = "query" | "mutation" | "subscription" | "unknown";

export function classifyRawGraphQLOperation(query: string): RawGraphQLOperationKind {
  const operations = scanOperationDefinitions(query);
  if (operations.has("subscription")) return "subscription";
  if (operations.has("mutation")) return "mutation";
  if (operations.has("query")) return "query";
  return "unknown";
}

export function assertRawGraphQLOperationAllowed(
  query: string,
  opts: {
    allowMutation?: boolean;
    mutationMessage: string;
    mutationHint: string;
    surface: string;
  },
): RawGraphQLOperationKind {
  const operationKind = classifyRawGraphQLOperation(query);
  if (operationKind === "query") return operationKind;
  if (operationKind === "mutation" && opts.allowMutation) return operationKind;
  if (operationKind === "mutation") {
    throw new ValidationError(opts.mutationMessage, opts.mutationHint);
  }
  throw new ValidationError(
    `${opts.surface} requires a GraphQL query or explicitly allowed mutation operation, got ${operationKind}`,
    "provide a query document, or provide a mutation with the explicit mutation opt-in",
  );
}

export function assertRawGraphQLPaginateAllowed(query: string): void {
  const operationKind = classifyRawGraphQLOperation(query);
  if (operationKind === "query") return;
  throw new ValidationError(
    `--paginate requires a GraphQL query operation, got ${operationKind}`,
    "remove --paginate, or provide a query that returns a top-level connection with nodes and pageInfo",
  );
}

function scanOperationDefinitions(query: string): Set<Exclude<RawGraphQLOperationKind, "unknown">> {
  const operations = new Set<Exclude<RawGraphQLOperationKind, "unknown">>();
  let i = 0;
  let braceDepth = 0;
  let sawTopLevelName = false;
  while (i < query.length) {
    const next = skipTrivia(query, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const char = query[i];
    if (char === '"' && query.startsWith('"""', i)) {
      i = skipBlockString(query, i + 3);
      continue;
    }
    if (char === '"') {
      i = skipString(query, i + 1);
      continue;
    }
    if (char === "{") {
      if (braceDepth === 0 && operations.size === 0 && !sawTopLevelName) operations.add("query");
      braceDepth++;
      i++;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      i++;
      continue;
    }
    if (braceDepth === 0 && isNameStart(char)) {
      const start = i;
      i++;
      while (i < query.length && isNameContinue(query[i])) i++;
      sawTopLevelName = true;
      const token = query.slice(start, i).toLowerCase();
      if (token === "query" || token === "mutation" || token === "subscription") {
        operations.add(token);
      }
      continue;
    }
    i++;
  }
  return operations;
}

function skipTrivia(query: string, start: number): number {
  let i = start;
  while (i < query.length) {
    const char = query[i];
    if (char === "\uFEFF" || /\s/.test(char ?? "")) {
      i++;
      continue;
    }
    if (char === "#") {
      while (i < query.length && query[i] !== "\n") i++;
      continue;
    }
    break;
  }
  return i;
}

function skipString(query: string, start: number): number {
  let escaped = false;
  let i = start;
  while (i < query.length) {
    const char = query[i];
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (char === '"') return i + 1;
    i++;
  }
  return i;
}

function skipBlockString(query: string, start: number): number {
  const end = query.indexOf('"""', start);
  return end === -1 ? query.length : end + 3;
}

function isNameStart(char: string | undefined): boolean {
  return char !== undefined && /[_A-Za-z]/.test(char);
}

function isNameContinue(char: string | undefined): boolean {
  return char !== undefined && /[_0-9A-Za-z]/.test(char);
}
