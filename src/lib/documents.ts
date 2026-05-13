/**
 * Document CRUD over Linear's Doc type. Documents can live at workspace
 * level, scoped to a project, or attached to an issue.
 *
 * Linear renamed `Document.slug` to `slugId` in 2026; we read `slugId` and
 * surface it as `slug_id` on the shaped record.
 */

import { NotFoundError, tryMapToNull, ValidationError } from "./errors.ts";
import { paginateRaw } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

/**
 * Linear's `icon` field is an internal name (PascalCase, e.g. "BarChart" or
 * "Rocket"). Passing a Unicode emoji silently round-trips as a non-functional
 * string; reject those up-front with a structured ValidationError so callers
 * get an actionable message instead of an opaque server-side rejection.
 *
 * Uses `\p{Extended_Pictographic}` (Unicode 9+) which covers emoji, dingbats,
 * symbols, and the bulk of icon-shaped pictographic codepoints.
 */
function assertIconNotEmoji(icon: string | undefined, field = "icon"): void {
  if (icon === undefined) return;
  if (/^\p{Extended_Pictographic}/u.test(icon)) {
    throw new ValidationError(
      `${field} "${icon}" looks like an emoji — Linear expects an internal icon name (PascalCase)`,
      "use a name like 'BarChart', 'Rocket', 'Target'. Omit if unsure.",
    );
  }
}

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
  // `tryMapToNull` turns SDK-boundary `NotFoundError` into a `null` return,
  // preserving the documented "missing → null" contract while propagating
  // other LebopError subtypes unchanged.
  type Resp = { data: { document: (DocNode & { content: string | null }) | null } };
  const response = await tryMapToNull<Resp>(
    () => withClient((c) => c.client.rawRequest(GET_DOCUMENT_QUERY, { id })) as Promise<Resp>,
  );
  if (!response) return null;
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
  assertIconNotEmoji(input.icon);
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
  assertIconNotEmoji(input.icon);
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
  // Round-7 / Q2 (refined): Linear's `documentDelete` is a SOFT delete —
  // sets `archivedAt` on the document and `documentDelete` itself returns
  // `success: true` on any id, including already-archived ones. To make
  // the `tryIdempotentDelete` contract uniform across all six delete
  // surfaces, pre-flight via `getDocument` AND check `archived_at`. If the
  // doc is absent OR already archived (= already-deleted), throw
  // `NotFoundError` so the helper emits `{status: "already-absent"}`.
  // Without this, re-deleting an already-deleted document returned
  // `{status: "deleted"}` and lied to callers.
  //
  // Round-8 / M5 note: this conflates "user explicitly archived" with
  // "user already deleted" — both surface as `archived_at !== null`. A
  // caller who archived then deletes gets `already-absent`, which is
  // technically a no-op on the second call. Defensible: Linear's
  // `documentDelete` and `documentArchive` produce the same on-disk
  // shape, so distinguishing post-hoc would require a separate signal
  // Linear doesn't expose. Document via the tool description.
  const existing = await getDocument(id);
  if (!existing || existing.archived_at !== null) {
    throw new NotFoundError(
      `document not found: ${id}`,
      "the document may have already been deleted",
    );
  }
  // NOT retry-wrapped — second call would error after the first success.
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_DOCUMENT_MUTATION, { id })) as {
    data: { documentDelete: { success: boolean } };
  };
  return response.data.documentDelete.success;
}
