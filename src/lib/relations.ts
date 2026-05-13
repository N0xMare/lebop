import { ValidationError } from "./errors.ts";
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
  if (!/^[A-Z]+-\d+$/.test(target)) {
    throw new ValidationError(
      `invalid target identifier "${target}" — expected TEAM-NN`,
      "target identifiers must look like TEAM-NN (e.g. UE-101)",
    );
  }
  return { op, kind: kind as LinkKind, target };
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

const FIND_QUERY = /* GraphQL */ `
  query FindRelation($id: String!) {
    issue(id: $id) {
      relations {
        nodes { id type relatedIssue { id identifier } }
      }
      inverseRelations {
        nodes { id type issue { id identifier } }
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
  return { id: response.data.issueRelationCreate.issueRelation.id };
}

export async function findLink(
  selfIdentifier: string,
  targetIdentifier: string,
  kind: LinkKind,
): Promise<string | null> {
  const { type, direction } = LINK_KIND_TO_API[kind];
  const response = (await withClient((c) =>
    c.client.rawRequest(FIND_QUERY, { id: selfIdentifier }),
  )) as {
    data: {
      issue: {
        relations: {
          nodes: {
            id: string;
            type: ApiType;
            relatedIssue: { id: string; identifier: string };
          }[];
        };
        inverseRelations: {
          nodes: { id: string; type: ApiType; issue: { id: string; identifier: string } }[];
        };
      } | null;
    };
  };
  const issue = response.data.issue;
  if (!issue) return null;
  // Defensive uppercase compare: Linear identifiers are uppercase by convention
  // ("NOX-123"), and `selfIdentifier`/`targetIdentifier` flow from user input
  // through `resolveIdentifier` which already normalizes. Locking the
  // comparison side at this boundary hardens against future call sites that
  // skip normalization or any backend alias-resolution that surfaces lowercase
  // identifiers — would otherwise silently miss matches.
  const target = targetIdentifier.toUpperCase();
  if (direction === "forward") {
    const match = issue.relations.nodes.find(
      (r) => r.type === type && r.relatedIssue.identifier.toUpperCase() === target,
    );
    return match?.id ?? null;
  }
  const match = issue.inverseRelations.nodes.find(
    (r) => r.type === type && r.issue.identifier.toUpperCase() === target,
  );
  return match?.id ?? null;
}

export async function deleteLink(relationId: string): Promise<void> {
  // Delete is NOT wrapped with retry — re-running after first success would
  // surface as "not found" since the relation UUID is already gone.
  const client = await linear();
  await client.client.rawRequest(DELETE_MUTATION, { id: relationId });
}

export async function listRelations(selfIdentifier: string): Promise<{
  outbound: { id: string; type: ApiType; otherIdentifier: string }[];
  inbound: { id: string; type: ApiType; otherIdentifier: string }[];
}> {
  const response = (await withClient((c) =>
    c.client.rawRequest(FIND_QUERY, { id: selfIdentifier }),
  )) as {
    data: {
      issue: {
        relations: {
          nodes: { id: string; type: ApiType; relatedIssue: { identifier: string } }[];
        };
        inverseRelations: {
          nodes: { id: string; type: ApiType; issue: { identifier: string } }[];
        };
      } | null;
    };
  };
  const issue = response.data.issue;
  if (!issue) return { outbound: [], inbound: [] };
  return {
    outbound: issue.relations.nodes.map((r) => ({
      id: r.id,
      type: r.type,
      otherIdentifier: r.relatedIssue.identifier,
    })),
    inbound: issue.inverseRelations.nodes.map((r) => ({
      id: r.id,
      type: r.type,
      otherIdentifier: r.issue.identifier,
    })),
  };
}
