import { z } from "zod";
import {
  type IssueCacheRefreshResult,
  refreshCachedIssueByIdentifier,
} from "../lib/cacheRefresh.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import {
  assertRelationCreateConfirmed,
  createLink,
  deleteLink,
  findLink,
  LINK_KINDS,
  type LinkDelta,
  type LinkKind,
  type ListedRelationsPage,
  listRelations,
  parseLinkToken,
  preflightCreateLink,
  type RelationCreatePreflight,
  relationBatchAddsRequireConfirmation,
  relationDeltaKey,
  relationPairKey,
} from "../lib/relations.ts";
import { withClient } from "../lib/sdk.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, repoRootArg, workspaceArg } from "./schema.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const linkKindSchema = z.enum(LINK_KINDS as readonly [LinkKind, ...LinkKind[]]);

export type RelationChannel = "cli" | "mcp";

export type RelationMutationStatus =
  | "created"
  | "deleted"
  | "unchanged"
  | "already-absent"
  | "created-writeback-failed"
  | "deleted-writeback-failed";

export interface RelationCacheContext {
  repoHash?: string;
  repoRoot?: string | null;
}

/** Optional MCP (or test) cache-context resolver; CLI omits and uses cwd defaults. */
export interface RelationMutationDeps {
  resolveCacheContext?: (repoRoot?: string) => RelationCacheContext;
}

export function relationWritebackFailed(cache: IssueCacheRefreshResult): boolean {
  return cache.present && !cache.refreshed && cache.error !== undefined;
}

export function relationMutationStatus(
  base: "created",
  cache: IssueCacheRefreshResult,
): "created" | "created-writeback-failed";
export function relationMutationStatus(
  base: "deleted",
  cache: IssueCacheRefreshResult,
): "deleted" | "deleted-writeback-failed";
export function relationMutationStatus(
  base: "created" | "deleted",
  cache: IssueCacheRefreshResult,
): "created" | "deleted" | "created-writeback-failed" | "deleted-writeback-failed" {
  if (!relationWritebackFailed(cache)) return base;
  return base === "created" ? "created-writeback-failed" : "deleted-writeback-failed";
}

export function parseRelationKind(input: string): LinkKind {
  const normalized = input.toLowerCase().replace(/_/g, "-");
  if (!(LINK_KINDS as readonly string[]).includes(normalized)) {
    throw new ValidationError(
      `unknown relation kind "${input}". supported: ${LINK_KINDS.join(", ")}`,
      `pick one of: ${LINK_KINDS.join(", ")} (use \`lebop raw\` for similar)`,
    );
  }
  return normalized as LinkKind;
}

function issueNotFound(
  identifier: string,
  channel: RelationChannel,
  role: "issue" | "target",
): never {
  if (role === "target") {
    if (channel === "mcp") {
      throw new NotFoundError(
        `link target not found: ${identifier}`,
        `verify ${identifier} exists and is visible to your token`,
      );
    }
    throw new NotFoundError(`link target not found: ${identifier}`);
  }
  if (channel === "mcp") {
    throw new NotFoundError(
      `issue not found: ${identifier}`,
      `verify ${identifier} exists and is visible to your token`,
    );
  }
  throw new NotFoundError(`issue not found: ${identifier}`);
}

function emptyCacheWriteback(identifier: string): IssueCacheRefreshResult {
  return {
    checked: false,
    present: false,
    refreshed: false,
    identifier,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface RelationListInput {
  identifier: string;
}

export interface RelationListCliInput {
  id: string;
}

export type RelationListMcpInput = Record<string, unknown> & {
  identifier: string;
};

export interface RelationListResult {
  identifier: string;
  outbound: ListedRelationsPage["outbound"];
  inbound: ListedRelationsPage["inbound"];
  complete: boolean;
  issueMissing?: boolean;
  pageInfo: ListedRelationsPage["pageInfo"];
}

const relationListCanonicalSchema = z.object({ identifier: z.string().min(1) }).strict();

export function buildRelationListInputFromCli(input: RelationListCliInput): RelationListInput {
  return parseSurfaceInput("relations.list", relationListCanonicalSchema, {
    identifier: input.id.toUpperCase(),
  });
}

export function buildRelationListInputFromMcp(input: RelationListMcpInput): RelationListInput {
  return parseSurfaceInput("relations.list", relationListCanonicalSchema, {
    identifier: String(input.identifier).toUpperCase(),
  });
}

export async function executeRelationList(input: RelationListInput): Promise<RelationListResult> {
  const identifier = input.identifier.toUpperCase();
  const result = await listRelations(identifier);
  return {
    identifier,
    outbound: result.outbound,
    inbound: result.inbound,
    complete: result.complete,
    ...(result.issueMissing !== undefined ? { issueMissing: result.issueMissing } : {}),
    pageInfo: result.pageInfo,
  };
}

export function relationListPayload(result: RelationListResult) {
  return {
    identifier: result.identifier,
    outbound: result.outbound,
    inbound: result.inbound,
  };
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

export interface RelationAddInput {
  from: string;
  kind: LinkKind;
  to: string;
  confirmed: boolean;
  channel: RelationChannel;
  /** Raw MCP `repo_root` (resolved only after a successful create). */
  repoRoot?: string;
}

export interface RelationAddCliInput {
  id: string;
  kind: string;
  other: string;
  opts: { yes?: boolean };
}

export type RelationAddMcpInput = Record<string, unknown> & {
  from: string;
  kind: LinkKind;
  to: string;
  confirm?: boolean;
  repo_root?: string;
};

export interface RelationAddResult {
  requestedFrom: string;
  resolvedFrom: string;
  kind: LinkKind;
  to: string;
  status: "unchanged" | "created" | "created-writeback-failed";
  relationId: string;
  preflight: RelationCreatePreflight;
  cache: IssueCacheRefreshResult;
  writebackFailed: boolean;
}

const relationAddCanonicalSchema = z
  .object({
    from: z.string().min(1),
    kind: linkKindSchema,
    to: z.string().min(1),
    confirmed: z.boolean(),
    channel: z.enum(["cli", "mcp"]),
    repoRoot: z.string().optional(),
  })
  .strict();

export function buildRelationAddInputFromCli(input: RelationAddCliInput): RelationAddInput {
  return parseSurfaceInput("relations.add", relationAddCanonicalSchema, {
    from: input.id.toUpperCase(),
    kind: parseRelationKind(input.kind),
    to: input.other.toUpperCase(),
    confirmed: input.opts.yes === true,
    channel: "cli" as const,
  });
}

export function buildRelationAddInputFromMcp(input: RelationAddMcpInput): RelationAddInput {
  return parseSurfaceInput("relations.add", relationAddCanonicalSchema, {
    from: String(input.from).toUpperCase(),
    kind: input.kind,
    to: String(input.to).toUpperCase(),
    confirmed: input.confirm === true,
    channel: "mcp" as const,
    repoRoot: input.repo_root,
  });
}

export async function executeRelationAdd(
  input: RelationAddInput,
  deps: RelationMutationDeps = {},
): Promise<RelationAddResult> {
  const upperFrom = input.from.toUpperCase();
  const upperTo = input.to.toUpperCase();
  const preflight = await preflightCreateLink(upperFrom, upperTo, input.kind);
  assertRelationCreateConfirmed(preflight, input.confirmed);

  const [self, target] = await Promise.all([
    withClient((c) => c.issue(upperFrom)),
    withClient((c) => c.issue(upperTo)),
  ]);
  if (!self) issueNotFound(upperFrom, input.channel, "issue");
  if (!target) issueNotFound(upperTo, input.channel, "target");

  if (preflight.exact) {
    const cache = emptyCacheWriteback(upperFrom);
    return {
      requestedFrom: upperFrom,
      resolvedFrom: self.identifier,
      kind: input.kind,
      to: upperTo,
      status: "unchanged",
      relationId: preflight.exact.id,
      preflight,
      cache,
      writebackFailed: false,
    };
  }

  // Create first, then resolve cache context (matches legacy MCP order).
  const result = await createLink(self.id, target.id, input.kind);
  const cacheContext = deps.resolveCacheContext?.(input.repoRoot) ?? {};
  const cache = await refreshCachedIssueByIdentifier(upperFrom, {
    repoHash: cacheContext.repoHash,
    repoRoot: cacheContext.repoRoot,
  });
  const status = relationMutationStatus("created", cache);
  return {
    requestedFrom: upperFrom,
    resolvedFrom: self.identifier,
    kind: input.kind,
    to: upperTo,
    status,
    relationId: result.id,
    preflight,
    cache,
    writebackFailed: relationWritebackFailed(cache),
  };
}

/** CLI JSON envelope fields for relation add. */
export function relationAddCliPayload(result: RelationAddResult) {
  return {
    op: "add" as const,
    from: result.requestedFrom,
    kind: result.kind,
    to: result.to,
    status: result.status,
    relation_id: result.relationId,
    relation_preflight: result.preflight,
    cache_writeback: result.cache,
  };
}

/** MCP JSON envelope fields for relation add. */
export function relationAddMcpPayload(result: RelationAddResult) {
  return {
    from: result.resolvedFrom,
    requested_from: result.requestedFrom,
    kind: result.kind,
    to: result.to,
    status: result.status,
    relation_id: result.relationId,
    relation_preflight: result.preflight,
    cache: result.cache,
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface RelationDeleteInput {
  from: string;
  kind: LinkKind;
  to: string;
  channel: RelationChannel;
  /** Raw MCP `repo_root` (resolved only after a successful delete). */
  repoRoot?: string;
}

export interface RelationDeleteCliInput {
  id: string;
  kind: string;
  other: string;
  opts: { yes?: boolean };
}

export type RelationDeleteMcpInput = Record<string, unknown> & {
  from: string;
  kind: LinkKind;
  to: string;
  confirm?: boolean;
  repo_root?: string;
};

export interface RelationDeleteResult {
  from: string;
  kind: LinkKind;
  to: string;
  status: "already-absent" | "deleted" | "deleted-writeback-failed";
  relationId?: string;
  cache?: IssueCacheRefreshResult;
  writebackFailed: boolean;
}

const relationDeleteCanonicalSchema = z
  .object({
    from: z.string().min(1),
    kind: linkKindSchema,
    to: z.string().min(1),
    channel: z.enum(["cli", "mcp"]),
    repoRoot: z.string().optional(),
  })
  .strict();

export function buildRelationDeleteInputFromCli(
  input: RelationDeleteCliInput,
): RelationDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      "refusing to delete relation without --yes",
      "re-run with --yes to confirm this destructive state change",
    );
  }
  return parseSurfaceInput("relations.delete", relationDeleteCanonicalSchema, {
    from: input.id.toUpperCase(),
    kind: parseRelationKind(input.kind),
    to: input.other.toUpperCase(),
    channel: "cli" as const,
  });
}

export function buildRelationDeleteInputFromMcp(
  input: RelationDeleteMcpInput,
): RelationDeleteInput {
  return parseSurfaceInput("relations.delete", relationDeleteCanonicalSchema, {
    from: String(input.from).toUpperCase(),
    kind: input.kind,
    to: String(input.to).toUpperCase(),
    channel: "mcp" as const,
    repoRoot: input.repo_root,
  });
}

export async function executeRelationDelete(
  input: RelationDeleteInput,
  deps: RelationMutationDeps = {},
): Promise<RelationDeleteResult> {
  const upperFrom = input.from.toUpperCase();
  const upperTo = input.to.toUpperCase();
  const relationId = await findLink(upperFrom, upperTo, input.kind);
  if (!relationId) {
    return {
      from: upperFrom,
      kind: input.kind,
      to: upperTo,
      status: "already-absent",
      writebackFailed: false,
    };
  }

  // Delete first, then resolve cache context (matches legacy MCP order).
  await deleteLink(relationId);
  const cacheContext = deps.resolveCacheContext?.(input.repoRoot) ?? {};
  const cache = await refreshCachedIssueByIdentifier(upperFrom, {
    repoHash: cacheContext.repoHash,
    repoRoot: cacheContext.repoRoot,
  });
  const status = relationMutationStatus("deleted", cache);
  return {
    from: upperFrom,
    kind: input.kind,
    to: upperTo,
    status,
    relationId,
    cache,
    writebackFailed: relationWritebackFailed(cache),
  };
}

export function relationDeleteCliPayload(result: RelationDeleteResult) {
  if (result.status === "already-absent") {
    return {
      op: "delete" as const,
      from: result.from,
      kind: result.kind,
      to: result.to,
      status: result.status,
    };
  }
  return {
    op: "delete" as const,
    from: result.from,
    kind: result.kind,
    to: result.to,
    status: result.status,
    relation_id: result.relationId,
    cache_writeback: result.cache,
  };
}

export function relationDeleteMcpPayload(result: RelationDeleteResult) {
  if (result.status === "already-absent") {
    return {
      op: "delete" as const,
      from: result.from,
      kind: result.kind,
      to: result.to,
      status: result.status,
    };
  }
  return {
    op: "delete" as const,
    from: result.from,
    kind: result.kind,
    to: result.to,
    status: result.status,
    relation_id: result.relationId,
    cache: result.cache,
  };
}

// ---------------------------------------------------------------------------
// Update (batch deltas — MCP update_relations; CLI set links stays asymmetric)
// ---------------------------------------------------------------------------

export interface RelationUpdateDeltaInput {
  op: "add" | "remove" | "+" | "-";
  kind: LinkKind;
  to: string;
}

export interface RelationUpdateInput {
  from: string;
  deltas: LinkDelta[];
  confirmed: boolean;
  /** Raw MCP `repo_root` (resolved after applying deltas). */
  repoRoot?: string;
}

export interface RelationUpdateCliInput {
  id: string;
  /** Parsed `+KIND:ID` / `-KIND:ID` tokens (flags already stripped). */
  tokens: string[];
  opts: { yes?: boolean };
}

export type RelationUpdateMcpInput = Record<string, unknown> & {
  from: string;
  deltas: RelationUpdateDeltaInput[];
  confirm?: boolean;
  repo_root?: string;
};

export interface RelationUpdateDeltaResult {
  op: "+" | "-";
  kind: LinkKind;
  to: string;
  status:
    | "created"
    | "deleted"
    | "unchanged"
    | "already-absent"
    | "created-writeback-failed"
    | "deleted-writeback-failed"
    | "error";
  relation_id?: string;
  relation_preflight?: RelationCreatePreflight;
  error?: string;
}

export interface RelationUpdateResult {
  requestedFrom: string;
  resolvedFrom: string;
  results: RelationUpdateDeltaResult[];
  cache: IssueCacheRefreshResult;
  writebackFailed: boolean;
}

const relationUpdateCanonicalSchema = z
  .object({
    from: z.string().min(1),
    deltas: z
      .array(
        z.object({
          op: z.enum(["+", "-"]),
          kind: linkKindSchema,
          target: z.string().min(1),
        }),
      )
      .min(1),
    confirmed: z.boolean(),
    repoRoot: z.string().optional(),
  })
  .strict();

/** True when MCP handler must call requireConfirm before execute. */
export function relationUpdateRequiresConfirm(deltas: readonly LinkDelta[]): boolean {
  return deltas.some((delta) => delta.op === "-") || relationBatchAddsRequireConfirmation(deltas);
}

/**
 * CLI `set links` adapter: token parse + early --yes gates (before any API).
 * Keeps set-links UX (tokens, multi-field `set` command) while sharing execute.
 */
export function buildRelationUpdateInputFromCli(
  input: RelationUpdateCliInput,
): RelationUpdateInput {
  if (input.tokens.length === 0) {
    throw new ValidationError(
      "`set links` requires at least one +KIND:ID or -KIND:ID token",
      "pass one or more link delta tokens",
    );
  }
  const deltas = input.tokens.map(parseLinkToken);
  const confirmed = input.opts.yes === true;
  if (deltas.some((delta) => delta.op === "-") && !confirmed) {
    throw new ValidationError(
      "refusing to remove links without --yes",
      "re-run with --yes to confirm this destructive state change",
    );
  }
  if (relationBatchAddsRequireConfirmation(deltas) && !confirmed) {
    throw new ValidationError(
      "refusing to add multiple relation kinds for the same issue pair without --yes",
      "Linear stores one relation per issue pair; re-run with --yes after verifying the batch replacement order is intended",
    );
  }
  return parseSurfaceInput("relations.update", relationUpdateCanonicalSchema, {
    from: input.id.toUpperCase(),
    deltas,
    confirmed,
  });
}

export function buildRelationUpdateInputFromMcp(
  input: RelationUpdateMcpInput,
): RelationUpdateInput {
  const rawDeltas = input.deltas ?? [];
  const deltas = rawDeltas.map(
    (delta): LinkDelta =>
      parseLinkToken(
        `${delta.op === "add" || delta.op === "+" ? "+" : "-"}${delta.kind}:${delta.to}`,
      ),
  );
  return parseSurfaceInput("relations.update", relationUpdateCanonicalSchema, {
    from: String(input.from).toUpperCase(),
    deltas,
    confirmed: input.confirm === true,
    repoRoot: input.repo_root,
  });
}

export async function executeRelationUpdate(
  input: RelationUpdateInput,
  deps: RelationMutationDeps = {},
): Promise<RelationUpdateResult> {
  const upperFrom = input.from.toUpperCase();
  const deltas = input.deltas;
  const confirmed = input.confirmed;

  const self = await withClient((c) => c.issue(upperFrom));
  if (!self) {
    throw new NotFoundError(
      `issue not found: ${upperFrom}`,
      `verify ${upperFrom} exists and is visible to your token`,
    );
  }

  const uniqueTargets = [...new Set(deltas.map((delta) => delta.target))];
  const targetMap = new Map<string, string>();
  await Promise.all(
    uniqueTargets.map(async (targetIdentifier) => {
      const target = await withClient((c) => c.issue(targetIdentifier));
      if (!target) {
        throw new NotFoundError(
          `link target not found: ${targetIdentifier}`,
          `verify ${targetIdentifier} exists and is visible to your token`,
        );
      }
      targetMap.set(targetIdentifier, target.id);
    }),
  );

  const createPreflights = new Map<string, RelationCreatePreflight>();
  for (const delta of deltas.filter((entry) => entry.op === "+")) {
    const key = relationDeltaKey(delta);
    if (createPreflights.has(key)) continue;
    const preflight = await preflightCreateLink(self.identifier, delta.target, delta.kind);
    assertRelationCreateConfirmed(preflight, confirmed);
    createPreflights.set(key, preflight);
  }

  const results: RelationUpdateDeltaResult[] = [];
  const dirtyPairs = new Set<string>();
  for (const delta of deltas) {
    try {
      if (delta.op === "+") {
        const pairKey = relationPairKey(delta.target);
        const preflight = dirtyPairs.has(pairKey)
          ? await preflightCreateLink(self.identifier, delta.target, delta.kind)
          : createPreflights.get(relationDeltaKey(delta));
        if (preflight) assertRelationCreateConfirmed(preflight, confirmed);
        if (preflight?.exact) {
          results.push({
            op: "+",
            kind: delta.kind,
            to: delta.target,
            status: "unchanged",
            relation_id: preflight.exact.id,
            relation_preflight: preflight,
          });
          continue;
        }
        const targetId = targetMap.get(delta.target);
        if (!targetId) throw new NotFoundError(`link target not found: ${delta.target}`);
        const created = await createLink(self.id, targetId, delta.kind);
        dirtyPairs.add(pairKey);
        results.push({
          op: "+",
          kind: delta.kind,
          to: delta.target,
          status: "created",
          relation_id: created.id,
          ...(preflight ? { relation_preflight: preflight } : {}),
        });
      } else {
        const relationId = await findLink(self.identifier, delta.target, delta.kind);
        if (!relationId) {
          results.push({
            op: "-",
            kind: delta.kind,
            to: delta.target,
            status: "already-absent",
          });
          continue;
        }
        await deleteLink(relationId);
        dirtyPairs.add(relationPairKey(delta.target));
        results.push({
          op: "-",
          kind: delta.kind,
          to: delta.target,
          status: "deleted",
          relation_id: relationId,
        });
      }
    } catch (err) {
      results.push({
        op: delta.op,
        kind: delta.kind,
        to: delta.target,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Resolve cache context after mutations (matches legacy MCP order).
  const cacheContext = deps.resolveCacheContext?.(input.repoRoot) ?? {};
  const cache = await refreshCachedIssueByIdentifier(self.identifier, {
    repoHash: cacheContext.repoHash,
    repoRoot: cacheContext.repoRoot,
  });
  const writebackFailed = relationWritebackFailed(cache);
  if (writebackFailed) {
    for (const result of results) {
      if (result.status === "created") result.status = "created-writeback-failed";
      if (result.status === "deleted") result.status = "deleted-writeback-failed";
    }
  }

  return {
    requestedFrom: upperFrom,
    resolvedFrom: self.identifier,
    results,
    cache,
    writebackFailed,
  };
}

export function relationUpdateMcpPayload(result: RelationUpdateResult) {
  return {
    from: result.resolvedFrom,
    requested_from: result.requestedFrom,
    results: result.results,
    cache: result.cache,
  };
}

/** CLI `set links` JSON shape — camelCase result rows + simplified cache_writeback. */
export type RelationUpdateCliCacheWriteback =
  | { status: "not-cached" }
  | { status: "refreshed" }
  | { status: "skipped-no-remote-row" }
  | { status: "failed"; error: string; code?: string; dirty?: { fields: string[] } };

export function relationUpdateCliCacheWriteback(
  cache: IssueCacheRefreshResult,
): RelationUpdateCliCacheWriteback {
  if (cache.refreshed) return { status: "refreshed" };
  if (!cache.present && cache.error === undefined) return { status: "not-cached" };
  if (cache.error?.code === "not_found") return { status: "skipped-no-remote-row" };
  if (cache.error) {
    return {
      status: "failed",
      error: cache.error.message,
      code: cache.error.code,
      ...(cache.dirty ? { dirty: cache.dirty } : {}),
    };
  }
  return { status: "failed", error: "cache refresh did not complete" };
}

export function relationUpdateCliPayload(result: RelationUpdateResult) {
  return {
    identifier: result.resolvedFrom,
    results: result.results.map((entry) => ({
      op: entry.op,
      kind: entry.kind,
      target: entry.to,
      status: entry.status,
      ...(entry.relation_id !== undefined ? { relationId: entry.relation_id } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    })),
    cache_writeback: relationUpdateCliCacheWriteback(result.cache),
  };
}

// ---------------------------------------------------------------------------
// MCP input schemas
// ---------------------------------------------------------------------------

export function buildRelationListMcpInputSchema(workspaceDescription: string) {
  return {
    identifier: z.string().describe("Issue identifier (e.g. 'TEAM-101')."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildRelationAddMcpInputSchema(workspaceDescription: string) {
  return {
    from: z.string().describe("Source issue identifier (e.g. 'TEAM-101')."),
    kind: linkKindSchema,
    to: z.string().describe("Target issue identifier."),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Required true only when creating this relation would replace an existing pair relation or create a duplicate relation with workflow side effects.",
      ),
    repo_root: repoRootArg.describe(
      "Repo root whose local cache should be refreshed after relation mutation.",
    ),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildRelationUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    from: z.string().describe("Source issue identifier (e.g. 'TEAM-101')."),
    deltas: z
      .array(
        z.object({
          op: z.enum(["add", "remove", "+", "-"]),
          kind: linkKindSchema,
          to: z.string().describe("Target issue identifier."),
        }),
      )
      .min(1)
      .describe("Relation deltas to apply in order."),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Required true when any delta removes a relation, or when an add preflight reports replacement/duplicate side effects.",
      ),
    repo_root: repoRootArg.describe(
      "Repo root whose local cache should be refreshed after relation mutations.",
    ),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildRelationDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    from: z.string().describe("Source issue identifier (e.g. 'TEAM-101')."),
    kind: linkKindSchema,
    to: z.string().describe("Target issue identifier."),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    repo_root: repoRootArg.describe(
      "Repo root whose local cache should be refreshed after relation mutation.",
    ),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

// ---------------------------------------------------------------------------
// Operation contracts
// ---------------------------------------------------------------------------

const addRelationDescription = `Add a Linear relation. Server-side idempotent at the (issueId, relatedIssueId, type) tuple — re-running with the same args returns the existing relation. Kinds: ${LINK_KINDS.join(" | ")}.`;
const listRelationsDescription = "Return outbound + inbound relations for one issue. Pure read.";
const deleteRelationDescription =
  "Remove a Linear relation. Idempotent at the pair level: returns status='already-absent' when no matching relation exists.";
const updateRelationsDescription =
  "Batch equivalent of `lebop set links`: apply multiple add/remove relation deltas for one source issue in one MCP call. Removals require confirm:true. Adds require confirm:true only when preflight reports relation replacement or duplicate-state side effects.";

export const relationListOperation = {
  id: "relations.list",
  domain: "relations",
  resource: "issue_relation",
  action: "list",
  title: "List relations for an issue",
  description: listRelationsDescription,
  cli: {
    command: "relation list",
    liveSteps: ["cli:relation add/list/delete --json", "cli:relation list --json"],
  },
  mcp: {
    tool: "list_relations",
    title: "List relations for an issue",
    description: listRelationsDescription,
    annotations: {
      title: "List relations for an issue",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["identifier", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildRelationListInputFromCli,
  fromMcp: buildRelationListInputFromMcp,
  execute: executeRelationList,
} satisfies SurfaceOperationContract<
  RelationListInput,
  RelationListResult,
  RelationListCliInput,
  RelationListMcpInput
>;

export const relationAddOperation = {
  id: "relations.add",
  domain: "relations",
  resource: "issue_relation",
  action: "create",
  title: "Create a relation between two issues",
  description: addRelationDescription,
  cli: {
    command: "relation add",
    liveSteps: ["cli:relation add/list/delete --json"],
  },
  mcp: {
    tool: "add_relation",
    title: "Create a relation between two issues",
    description: addRelationDescription,
    annotations: {
      title: "Create a relation between two issues",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["from", "kind", "to", "confirm", "repo_root", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  notes:
    "CLI JSON uses cache_writeback + op/from=requested id; MCP uses cache + from=resolved identifier + requested_from. Confirm only when preflight.needsConfirmation.",
  fromCli: buildRelationAddInputFromCli,
  fromMcp: (input: RelationAddMcpInput) => buildRelationAddInputFromMcp(input),
  execute: executeRelationAdd,
} satisfies SurfaceOperationContract<
  RelationAddInput,
  RelationAddResult,
  RelationAddCliInput,
  RelationAddMcpInput
>;

export const relationDeleteOperation = {
  id: "relations.delete",
  domain: "relations",
  resource: "issue_relation",
  action: "delete",
  title: "Delete a relation between two issues",
  description: deleteRelationDescription,
  cli: {
    command: "relation delete",
    liveSteps: ["cli:relation add/list/delete --json", "cli:relation delete --json"],
  },
  mcp: {
    tool: "delete_relation",
    title: "Delete a relation between two issues",
    description: deleteRelationDescription,
    annotations: {
      title: "Delete a relation between two issues",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["from", "kind", "to", "confirm", "repo_root", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    confirm: "required",
  },
  notes:
    "CLI --yes gated in fromCli; MCP requireConfirm in thin handler. CLI JSON uses cache_writeback; MCP uses cache.",
  fromCli: buildRelationDeleteInputFromCli,
  fromMcp: (input: RelationDeleteMcpInput) => buildRelationDeleteInputFromMcp(input),
  execute: executeRelationDelete,
} satisfies SurfaceOperationContract<
  RelationDeleteInput,
  RelationDeleteResult,
  RelationDeleteCliInput,
  RelationDeleteMcpInput
>;

export const relationUpdateOperation = {
  id: "relations.update",
  domain: "relations",
  resource: "issue_relation",
  action: "update",
  title: "Apply relation deltas for one issue",
  description: updateRelationsDescription,
  cli: {
    command: "set",
    liveSteps: ["cli:set links add --json", "cli:set links remove --json"],
  },
  mcp: {
    tool: "update_relations",
    title: "Apply relation deltas for one issue",
    description: updateRelationsDescription,
    liveSemantics: "required",
    annotations: {
      title: "Apply relation deltas for one issue",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["from", "deltas", "confirm", "repo_root", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  notes:
    "Intentional asymmetry: CLI batch is `set links` (token UX under multi-field set) vs MCP multi-delta update_relations; both share executeRelationUpdate. CLI JSON uses simplified cache_writeback + target/relationId; MCP uses cache + to/relation_id. Parallel metadata stub issues.relations_update remains until issues domain cleanup.",
  fromCli: buildRelationUpdateInputFromCli,
  fromMcp: (input: RelationUpdateMcpInput) => buildRelationUpdateInputFromMcp(input),
  execute: executeRelationUpdate,
} satisfies SurfaceOperationContract<
  RelationUpdateInput,
  RelationUpdateResult,
  RelationUpdateCliInput,
  RelationUpdateMcpInput
>;

export const RELATIONS_SURFACE_OPERATIONS = [
  relationAddOperation,
  relationUpdateOperation,
  relationListOperation,
  relationDeleteOperation,
] as const;
