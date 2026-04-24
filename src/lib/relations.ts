import { linear } from "./sdk.ts";

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
  const op = token[0];
  if (op !== "+" && op !== "-") {
    throw new Error(
      `link token "${token}" must start with + or - (e.g. +blocks:UE-101, -related:UE-102)`,
    );
  }
  const rest = token.slice(1);
  const colon = rest.indexOf(":");
  if (colon === -1) {
    throw new Error(
      `link token "${token}" must be of form ${op}KIND:TARGET — supported kinds: ${LINK_KINDS.join(", ")}`,
    );
  }
  const kind = rest.slice(0, colon);
  const target = rest.slice(colon + 1).toUpperCase();
  if (!(LINK_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `unknown link kind "${kind}". supported: ${LINK_KINDS.join(", ")} (similar lives in \`lebop raw\`)`,
    );
  }
  if (!/^[A-Z]+-\d+$/.test(target)) {
    throw new Error(`invalid target identifier "${target}" — expected TEAM-NN`);
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
  const client = await linear();
  const response = (await client.client.rawRequest(CREATE_MUTATION, { input })) as {
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
  const client = await linear();
  const response = (await client.client.rawRequest(FIND_QUERY, { id: selfIdentifier })) as {
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
  if (direction === "forward") {
    const match = issue.relations.nodes.find(
      (r) => r.type === type && r.relatedIssue.identifier === targetIdentifier,
    );
    return match?.id ?? null;
  }
  const match = issue.inverseRelations.nodes.find(
    (r) => r.type === type && r.issue.identifier === targetIdentifier,
  );
  return match?.id ?? null;
}

export async function deleteLink(relationId: string): Promise<void> {
  const client = await linear();
  await client.client.rawRequest(DELETE_MUTATION, { id: relationId });
}

export async function listRelations(selfIdentifier: string): Promise<{
  outbound: { id: string; type: ApiType; otherIdentifier: string }[];
  inbound: { id: string; type: ApiType; otherIdentifier: string }[];
}> {
  const client = await linear();
  const response = (await client.client.rawRequest(FIND_QUERY, { id: selfIdentifier })) as {
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
