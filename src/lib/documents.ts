/**
 * Document CRUD over Linear's Doc type. Documents can live at workspace
 * level, scoped to a project, or attached to an issue.
 *
 * Linear renamed `Document.slug` to `slugId` in 2026; we read `slugId` and
 * surface it as `slug_id` on the shaped record.
 */

import { paginateRaw } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedDocument {
  id: string;
  title: string;
  slug_id: string;
  icon: string | null;
  url: string;
  project: { id: string; name: string } | null;
  creator: { id: string; name: string; email: string } | null;
  archived_at: string | null;
}

export interface FullDocument extends ListedDocument {
  content: string | null;
}

const LIST_DOCUMENTS_QUERY = /* GraphQL */ `
  query ListDocuments($filter: DocumentFilter, $first: Int!, $after: String) {
    documents(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        title
        slugId
        icon
        url
        archivedAt
        project { id name }
        creator { id name email }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface DocNode {
  id: string;
  title: string;
  slugId: string;
  icon: string | null;
  url: string;
  archivedAt: string | null;
  project: { id: string; name: string } | null;
  creator: { id: string; name: string; email: string } | null;
}

interface DocsPage {
  data: {
    documents: {
      nodes: DocNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

function shape(d: DocNode): ListedDocument {
  return {
    id: d.id,
    title: d.title,
    slug_id: d.slugId,
    icon: d.icon,
    url: d.url,
    archived_at: d.archivedAt,
    project: d.project,
    creator: d.creator,
  };
}

export async function listDocuments(opts: {
  projectId?: string;
  max?: number;
}): Promise<ListedDocument[]> {
  const filter: Record<string, unknown> = {};
  if (opts.projectId) filter.project = { id: { eq: opts.projectId } };

  const client = await linear();
  const raw = await paginateRaw<DocNode, DocsPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_DOCUMENTS_QUERY, {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first,
        after,
      }) as Promise<DocsPage>,
    (response) => response.data.documents,
    { pageSize: 250, max: opts.max },
  );
  return raw.map(shape);
}

const GET_DOCUMENT_QUERY = /* GraphQL */ `
  query GetDocument($id: String!) {
    document(id: $id) {
      id
      title
      slugId
      icon
      url
      content
      archivedAt
      project { id name }
      creator { id name email }
    }
  }
`;

export async function getDocument(id: string): Promise<FullDocument | null> {
  const response = (await withClient((c) => c.client.rawRequest(GET_DOCUMENT_QUERY, { id }))) as {
    data: { document: (DocNode & { content: string | null }) | null };
  };
  const d = response.data.document;
  return d ? { ...shape(d), content: d.content } : null;
}

export interface CreateDocumentInput {
  title: string;
  content?: string;
  /** Project UUID. Documents must be attached to a project (not workspace-level via API). */
  projectId: string;
  icon?: string;
}

const CREATE_DOCUMENT_MUTATION = /* GraphQL */ `
  mutation CreateDocument($input: DocumentCreateInput!) {
    documentCreate(input: $input) {
      success
      document {
        id title slugId icon url content archivedAt
        project { id name }
        creator { id name email }
      }
    }
  }
`;

export async function createDocument(input: CreateDocumentInput): Promise<FullDocument> {
  // NOT retry-wrapped — non-idempotent.
  const client = await linear();
  const response = (await client.client.rawRequest(CREATE_DOCUMENT_MUTATION, { input })) as {
    data: {
      documentCreate: {
        success: boolean;
        document: DocNode & { content: string | null };
      };
    };
  };
  const d = response.data.documentCreate.document;
  return { ...shape(d), content: d.content };
}

export interface UpdateDocumentInput {
  title?: string;
  content?: string;
  icon?: string;
}

const UPDATE_DOCUMENT_MUTATION = /* GraphQL */ `
  mutation UpdateDocument($id: String!, $input: DocumentUpdateInput!) {
    documentUpdate(id: $id, input: $input) {
      success
      document {
        id title slugId icon url content archivedAt
        project { id name }
        creator { id name email }
      }
    }
  }
`;

export async function updateDocument(
  id: string,
  input: UpdateDocumentInput,
): Promise<FullDocument> {
  // Idempotent at the value level — retry-wrapped.
  const response = (await withClient((c) =>
    c.client.rawRequest(UPDATE_DOCUMENT_MUTATION, { id, input }),
  )) as {
    data: {
      documentUpdate: {
        success: boolean;
        document: DocNode & { content: string | null };
      };
    };
  };
  const d = response.data.documentUpdate.document;
  return { ...shape(d), content: d.content };
}

const DELETE_DOCUMENT_MUTATION = /* GraphQL */ `
  mutation DeleteDocument($id: String!) {
    documentDelete(id: $id) { success }
  }
`;

export async function deleteDocument(id: string): Promise<boolean> {
  // NOT wrapped — not-found after first success.
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_DOCUMENT_MUTATION, { id })) as {
    data: { documentDelete: { success: boolean } };
  };
  return response.data.documentDelete.success;
}
