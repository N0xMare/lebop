import { ValidationError } from "./errors.ts";
import { normalizeIssueIdentifier } from "./issueIdentifiers.ts";
import { requireMutationEntity, requireMutationSuccess } from "./mutationResult.ts";
import { resolveSafetyCap } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export type LinkKind = "blocks" | "blocked-by" | "duplicates" | "duplicated-by" | "related";

type ApiType = "blocks" | "duplicate" | "related";
type Direction = "forward" | "inverse";

const LINK_KIND_TO_API: Record<LinkKind, { type: ApiType; direction: Direction }> = {
  blocks: { type: "blocks", direction: "forward" },
  "blocked-by": { type: "blocks", direction: "inverse" },
  duplicates: { type: "duplicate", direction: "forward" },
  "duplicated-by": { type: "duplicate", direction: "inverse" },
  related: { type: "related", direction: "forward" },
};

export const LINK_KINDS: readonly LinkKind[] = Object.keys(LINK_KIND_TO_API) as LinkKind[];

export interface LinkDelta {
  op: "+" | "-";
  kind: LinkKind;
  target: string;
}

export function relationPairKey(targetIdentifier: string): string {
  return targetIdentifier.toUpperCase();
}

export function relationDeltaKey(delta: Pick<LinkDelta, "kind" | "target">): string {
  return `${delta.kind}:${relationPairKey(delta.target)}`;
}

export function relationBatchAddsRequireConfirmation(deltas: readonly LinkDelta[]): boolean {
  const kindsByTarget = new Map<string, Set<LinkKind>>();
  for (const delta of deltas) {
    if (delta.op !== "+") continue;
    const key = relationPairKey(delta.target);
    const kinds = kindsByTarget.get(key) ?? new Set<LinkKind>();
    kinds.add(delta.kind);
    kindsByTarget.set(key, kinds);
    if (kinds.size > 1) return true;
  }
  return false;
}

export function parseLinkToken(token: string): LinkDelta {
  // Round-6 / H7 (refined round-7 / HIGH-4): surfacing the commander
  // positional-vs-option ambiguity. `lebop set links ENG-1 -blocks:ENG-2
  // --team ENG` looks fine to the shell but commander parses `-blocks:…`
  // as a short option, shifting parser state so `--team` gets consumed
  // as a positional link token. Catch the long-form flag pattern
  // (`--foo`) — that's the only one that actually reaches this resolver
  // as a misclassified positional. (Round-6's second clause `token[1] ===
  // "-"` was dead code: it would have matched things like `+-foo`, never
  // commander's `-X` short options, which are stripped before reaching
  // parseLinkToken anyway.)
  if (token.startsWith("--")) {
    throw new ValidationError(
      `link token "${token}" looks like a CLI flag, not a link delta`,
      "place flags (--team, --json, ...) BEFORE positional link tokens, or use `--` to split: `lebop set links --team ENG ID +blocks:OTHER` or `lebop set links ID -- -blocks:OTHER`",
    );
  }
  const op = token[0];
  if (op !== "+" && op !== "-") {
    throw new ValidationError(
      `link token "${token}" must start with + or - (e.g. +blocks:UE-101, -related:UE-102)`,
      "prefix the token with `+` to add or `-` to remove",
    );
  }
  const rest = token.slice(1);
  const colon = rest.indexOf(":");
  if (colon === -1) {
    throw new ValidationError(
      `link token "${token}" must be of form ${op}KIND:TARGET — supported kinds: ${LINK_KINDS.join(", ")}`,
      `use the form ${op}KIND:TEAM-NN (e.g. ${op}blocks:UE-101)`,
    );
  }
  const kind = rest.slice(0, colon);
  const target = rest.slice(colon + 1).toUpperCase();
  if (!(LINK_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(
      `unknown link kind "${kind}". supported: ${LINK_KINDS.join(", ")} (similar lives in \`lebop raw\`)`,
      `pick one of: ${LINK_KINDS.join(", ")}`,
    );
  }
  try {
    return {
      op,
      kind: kind as LinkKind,
      target: normalizeIssueIdentifier(target, "target identifier"),
    };
  } catch {
    throw new ValidationError(
      `invalid target identifier "${target}" — expected TEAM-NN`,
      "target identifiers must look like TEAM-NN (e.g. UE-101)",
    );
  }
}

const CREATE_MUTATION = /* GraphQL */ `
  mutation CreateRelation($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation { id type }
    }
  }
`;

const DELETE_MUTATION = /* GraphQL */ `
  mutation DeleteRelation($id: String!) {
    issueRelationDelete(id: $id) { success }
  }
`;

const LIST_RELATIONS_QUERY = /* GraphQL */ `
  query ListRelations(
    $id: String!
    $first: Int!
    $outboundAfter: String
    $inboundAfter: String
    $includeOutbound: Boolean!
    $includeInbound: Boolean!
  ) {
    issue(id: $id) {
      relations(first: $first, after: $outboundAfter) @include(if: $includeOutbound) {
        nodes { id type relatedIssue { identifier } }
        pageInfo { hasNextPage endCursor }
      }
      inverseRelations(first: $first, after: $inboundAfter) @include(if: $includeInbound) {
        nodes { id type issue { identifier } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export interface RelationSummary {
  id: string;
  type: ApiType;
  otherIdentifier: string;
  direction: Direction;
}

export interface RelationCreatePreflight {
  fromIdentifier: string;
  toIdentifier: string;
  kind: LinkKind;
  existing: RelationSummary[];
  conflicts: RelationSummary[];
  exact?: RelationSummary;
  wouldReplace: boolean;
  duplicateSideEffect: boolean;
  needsConfirmation: boolean;
}

export interface ListedRelationsPage {
  outbound: { id: string; type: ApiType; otherIdentifier: string }[];
  inbound: { id: string; type: ApiType; otherIdentifier: string }[];
  complete: boolean;
  issueMissing?: boolean;
  pageInfo: {
    outbound: { hasNextPage: boolean; endCursor: string | null };
    inbound: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function createLink(
  selfUuid: string,
  targetUuid: string,
  kind: LinkKind,
): Promise<{ id: string }> {
  const { type, direction } = LINK_KIND_TO_API[kind];
  const input =
    direction === "forward"
      ? { type, issueId: selfUuid, relatedIssueId: targetUuid }
      : { type, issueId: targetUuid, relatedIssueId: selfUuid };
  // Server-side idempotent at the (issueId, relatedIssueId, type) tuple per
  // spec §12.1 — same input → same relation UUID, no duplicate. Safe to retry.
  const response = (await withClient((c) => c.client.rawRequest(CREATE_MUTATION, { input }))) as {
    data: { issueRelationCreate: { success: boolean; issueRelation: { id: string } } };
  };
  const relation = requireMutationEntity<{ id: string }>(
    "issueRelationCreate",
    response.data.issueRelationCreate as unknown as { success?: boolean } & Record<string, unknown>,
    "issueRelation",
  );
  return { id: relation.id };
}

export async function preflightCreateLink(
  selfIdentifier: string,
  targetIdentifier: string,
  kind: LinkKind,
): Promise<RelationCreatePreflight> {
  const relations = await listRelations(selfIdentifier);
  if (relations.issueMissing) {
    throw new ValidationError(
      `issue not found: ${selfIdentifier}`,
      "verify the source issue exists and is visible to your token",
    );
  }
  return analyzeRelationCreatePreflight(relations, selfIdentifier, targetIdentifier, kind);
}

export function analyzeRelationCreatePreflight(
  relations: ListedRelationsPage,
  selfIdentifier: string,
  targetIdentifier: string,
  kind: LinkKind,
): RelationCreatePreflight {
  const requested = LINK_KIND_TO_API[kind];
  const target = targetIdentifier.toUpperCase();
  const existing: RelationSummary[] = [
    ...relations.outbound
      .filter((r) => r.otherIdentifier.toUpperCase() === target)
      .map((r) => ({
        id: r.id,
        type: r.type,
        otherIdentifier: r.otherIdentifier,
        direction: "forward" as const,
      })),
    ...relations.inbound
      .filter((r) => r.otherIdentifier.toUpperCase() === target)
      .map((r) => ({
        id: r.id,
        type: r.type,
        otherIdentifier: r.otherIdentifier,
        direction: "inverse" as const,
      })),
  ];
  const exact = existing.find((relation) => relationMatchesKind(relation, requested));
  const conflicts = exact ? [] : existing;
  const duplicateSideEffect = requested.type === "duplicate" && exact === undefined;
  return {
    fromIdentifier: selfIdentifier.toUpperCase(),
    toIdentifier: target,
    kind,
    existing,
    conflicts,
    exact,
    wouldReplace: conflicts.length > 0,
    duplicateSideEffect,
    needsConfirmation: conflicts.length > 0 || duplicateSideEffect,
  };
}

export function assertRelationCreateConfirmed(
  preflight: RelationCreatePreflight,
  confirmed: boolean,
): void {
  if (!preflight.needsConfirmation || confirmed) return;
  const reasons: string[] = [];
  if (preflight.wouldReplace) {
    reasons.push(
      `would replace existing relation(s): ${preflight.conflicts
        .map(formatExistingRelation)
        .join(", ")}`,
    );
  }
  if (preflight.duplicateSideEffect) {
    reasons.push("duplicate relations can move involved issues to Linear's Duplicate state");
  }
  throw new ValidationError(
    `creating ${preflight.kind} relation ${preflight.fromIdentifier} -> ${preflight.toIdentifier} requires confirmation`,
    `pass --yes / confirm:true after verifying this intent: ${reasons.join("; ")}`,
  );
}

function relationMatchesKind(
  relation: RelationSummary,
  requested: { type: ApiType; direction: Direction },
): boolean {
  if (requested.type === "related") return relation.type === "related";
  return relation.type === requested.type && relation.direction === requested.direction;
}

function formatExistingRelation(relation: RelationSummary): string {
  return `${relation.direction} ${relation.type} ${relation.otherIdentifier}`;
}

export async function findLink(
  selfIdentifier: string,
  targetIdentifier: string,
  kind: LinkKind,
): Promise<string | null> {
  const { type, direction } = LINK_KIND_TO_API[kind];
  const relations = await listRelations(selfIdentifier);
  if (relations.issueMissing) return null;
  const target = targetIdentifier.toUpperCase();
  if (type === "related") {
    const outboundMatch = relations.outbound.find(
      (r) => r.type === type && r.otherIdentifier.toUpperCase() === target,
    );
    if (outboundMatch) return outboundMatch.id;
    const inboundMatch = relations.inbound.find(
      (r) => r.type === type && r.otherIdentifier.toUpperCase() === target,
    );
    return inboundMatch?.id ?? null;
  }
  if (direction === "forward") {
    const match = relations.outbound.find(
      (r) => r.type === type && r.otherIdentifier.toUpperCase() === target,
    );
    return match?.id ?? null;
  }
  const match = relations.inbound.find(
    (r) => r.type === type && r.otherIdentifier.toUpperCase() === target,
  );
  return match?.id ?? null;
}

export async function deleteLink(relationId: string): Promise<void> {
  // Delete is NOT wrapped with retry — re-running after first success would
  // surface as "not found" since the relation UUID is already gone.
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_MUTATION, { id: relationId })) as {
    data: { issueRelationDelete: { success: boolean } };
  };
  requireMutationSuccess("issueRelationDelete", response.data.issueRelationDelete);
}

export async function listRelations(selfIdentifier: string): Promise<ListedRelationsPage> {
  const outbound: ListedRelationsPage["outbound"] = [];
  const inbound: ListedRelationsPage["inbound"] = [];
  const cap = resolveSafetyCap();
  let outboundAfter: string | undefined;
  let inboundAfter: string | undefined;
  let outboundDone = false;
  let inboundDone = false;
  const outboundSeen = new Set<string>();
  const inboundSeen = new Set<string>();

  while (!outboundDone || !inboundDone) {
    const page = await listRelationsPage(selfIdentifier, {
      first: 250,
      ...(outboundDone ? { includeOutbound: false } : { outboundAfter, includeOutbound: true }),
      ...(inboundDone ? { includeInbound: false } : { inboundAfter, includeInbound: true }),
    });
    if (page.issueMissing) return page;

    if (!outboundDone) outbound.push(...page.outbound);
    if (!inboundDone) inbound.push(...page.inbound);

    if (page.pageInfo.outbound.hasNextPage && !page.pageInfo.outbound.endCursor) {
      throw new ValidationError(
        `relation list for ${selfIdentifier} cannot continue outbound page`,
        "Linear returned hasNextPage without endCursor",
      );
    }
    if (page.pageInfo.inbound.hasNextPage && !page.pageInfo.inbound.endCursor) {
      throw new ValidationError(
        `relation list for ${selfIdentifier} cannot continue inbound page`,
        "Linear returned hasNextPage without endCursor",
      );
    }
    if (
      page.pageInfo.outbound.hasNextPage &&
      page.pageInfo.outbound.endCursor &&
      outboundSeen.has(page.pageInfo.outbound.endCursor)
    ) {
      throw new ValidationError(
        `relation list for ${selfIdentifier} outbound cursor did not advance`,
        "Linear returned the same outbound endCursor on consecutive pages",
      );
    }
    if (
      page.pageInfo.inbound.hasNextPage &&
      page.pageInfo.inbound.endCursor &&
      inboundSeen.has(page.pageInfo.inbound.endCursor)
    ) {
      throw new ValidationError(
        `relation list for ${selfIdentifier} inbound cursor did not advance`,
        "Linear returned the same inbound endCursor on consecutive pages",
      );
    }
    if (page.pageInfo.outbound.hasNextPage && page.pageInfo.outbound.endCursor) {
      outboundSeen.add(page.pageInfo.outbound.endCursor);
    }
    if (page.pageInfo.inbound.hasNextPage && page.pageInfo.inbound.endCursor) {
      inboundSeen.add(page.pageInfo.inbound.endCursor);
    }
    outboundDone = !page.pageInfo.outbound.hasNextPage;
    inboundDone = !page.pageInfo.inbound.hasNextPage;
    outboundAfter = page.pageInfo.outbound.endCursor ?? undefined;
    inboundAfter = page.pageInfo.inbound.endCursor ?? undefined;

    if (outbound.length + inbound.length >= cap && (!outboundDone || !inboundDone)) {
      throw new ValidationError(
        `relation list for ${selfIdentifier} exceeded safety cap ${cap}`,
        "set LEBOP_MAX_ITEMS=N to raise the ceiling, or use a narrower relation operation",
      );
    }
  }

  return {
    outbound,
    inbound,
    complete: true,
    pageInfo: {
      outbound: { hasNextPage: false, endCursor: null },
      inbound: { hasNextPage: false, endCursor: null },
    },
  };
}

export async function listRelationsPage(
  selfIdentifier: string,
  opts: {
    first: number;
    outboundAfter?: string;
    inboundAfter?: string;
    includeOutbound?: boolean;
    includeInbound?: boolean;
  },
): Promise<ListedRelationsPage> {
  const first = Math.max(1, Math.min(Math.floor(opts.first), 250));
  const includeOutbound = opts.includeOutbound ?? true;
  const includeInbound = opts.includeInbound ?? true;
  const response = (await withClient((c) =>
    c.client.rawRequest(LIST_RELATIONS_QUERY, {
      id: selfIdentifier,
      first,
      outboundAfter: opts.outboundAfter,
      inboundAfter: opts.inboundAfter,
      includeOutbound,
      includeInbound,
    }),
  )) as {
    data: {
      issue: {
        relations?: {
          nodes: { id: string; type: ApiType; relatedIssue: { identifier: string } }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
        inverseRelations?: {
          nodes: { id: string; type: ApiType; issue: { identifier: string } }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    };
  };
  const issue = response.data.issue;
  if (!issue) {
    return {
      outbound: [],
      inbound: [],
      complete: true,
      issueMissing: true,
      pageInfo: {
        outbound: { hasNextPage: false, endCursor: null },
        inbound: { hasNextPage: false, endCursor: null },
      },
    };
  }
  const outboundPageInfo = issue.relations?.pageInfo ?? { hasNextPage: false, endCursor: null };
  const inboundPageInfo = issue.inverseRelations?.pageInfo ?? {
    hasNextPage: false,
    endCursor: null,
  };
  return {
    outbound: (issue.relations?.nodes ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      otherIdentifier: r.relatedIssue.identifier,
    })),
    inbound: (issue.inverseRelations?.nodes ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      otherIdentifier: r.issue.identifier,
    })),
    complete: !outboundPageInfo.hasNextPage && !inboundPageInfo.hasNextPage,
    pageInfo: {
      outbound: outboundPageInfo,
      inbound: inboundPageInfo,
    },
  };
}
