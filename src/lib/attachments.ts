/**
 * Attachment CRUD over Linear's Attachment type. An Attachment is a typed
 * link from an issue to an external resource (PR, design doc, calendar event,
 * etc.). The `attachmentLinkURL` mutation we already expose via `lebop link`
 * creates a URL-shaped attachment; this file owns the read + update + delete
 * paths so the surface is symmetric.
 *
 * Linear API surface used:
 *   - Issue.attachments connection (read)
 *   - attachmentUpdate(id, input) (update — title only; Linear does not allow URL edits)
 *   - attachmentDelete(id) (delete)
 */

import { mapSdkError, NotFoundError, ValidationError } from "./errors.ts";
import { requireMutationEntity, requireMutationSuccess } from "./mutationResult.ts";
import { paginateRaw, paginateRawPage } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";

export interface ListedAttachment {
  id: string;
  title: string;
  url: string;
  /**
   * Integration source type for attachments created via an integration
   * ("github", "slack", "figma", "linear-pr", etc.). Null for attachments
   * created via `link_url_to_issue` / generic `attachmentLinkURL`.
   */
  source_type: string | null;
  metadata: Record<string, unknown> | null;
  creator: { id: string; name: string; email: string } | null;
}

export interface LinkedUrlAttachment {
  id: string;
  title: string;
  url: string;
}

export interface LinkUrlAttachmentResult {
  issue: string;
  attachment: LinkedUrlAttachment;
  status: "linked" | "already-linked";
}

interface AttachmentNode {
  id: string;
  title: string;
  url: string;
  sourceType: string | null;
  metadata: Record<string, unknown> | null;
  creator: { id: string; name: string; email: string } | null;
}

interface AttachmentsPage {
  data: {
    issue: {
      attachments: {
        nodes: AttachmentNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  };
}

const LIST_ATTACHMENTS_QUERY = /* GraphQL */ `
  query ListAttachments($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      attachments(first: $first, after: $after) {
        nodes {
          id
          title
          url
          sourceType
          metadata
          creator { id name email }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const ATTACH_URL_MUTATION = /* GraphQL */ `
  mutation AttachURL($issueId: String!, $url: String!, $title: String!) {
    attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
      success
      attachment { id title url }
    }
  }
`;

function shape(a: AttachmentNode): ListedAttachment {
  return {
    id: a.id,
    title: a.title,
    url: a.url,
    source_type: a.sourceType,
    metadata: a.metadata,
    creator: a.creator,
  };
}

export async function linkUrlAttachment(
  identifier: string,
  url: string,
  title = url,
): Promise<LinkUrlAttachmentResult> {
  const upperId = identifier.toUpperCase();
  const fetched = await withClient((c) => c.issue(upperId));
  if (!fetched) {
    throw new NotFoundError(
      `issue not found: ${upperId}`,
      `verify ${upperId} exists and is visible to your token`,
    );
  }

  try {
    const client = await linear();
    const response = (await client.client.rawRequest(ATTACH_URL_MUTATION, {
      issueId: fetched.id,
      url,
      title,
    })) as {
      data: {
        attachmentLinkURL: {
          success: boolean;
          attachment: LinkedUrlAttachment;
        };
      };
    };
    const attachment = requireMutationEntity<LinkedUrlAttachment>(
      "attachmentLinkURL",
      response.data.attachmentLinkURL,
      "attachment",
    );
    return { issue: upperId, attachment, status: "linked" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already.*linked/i.test(msg)) {
      throw mapSdkError(err);
    }

    // Idempotent path: find the existing attachment and surface it with the
    // same envelope shape. listAttachments is scoped to the issue.
    const existing = await listAttachments(upperId);
    const match = existing.find((a) => a.url === url);
    if (!match) {
      throw mapSdkError(err);
    }
    return {
      issue: upperId,
      attachment: { id: match.id, title: match.title, url: match.url },
      status: "already-linked",
    };
  }
}

/**
 * List all attachments on one issue. Paginates server-side; capped by the
 * standard `LEBOP_MAX_ITEMS` runtime safety bound. Throws NotFoundError if
 * the issue identifier doesn't resolve — matches the wave-1 `get_*` contract
 * (caller can re-shape to `null` at the MCP/CLI boundary if preferred).
 */
export async function listAttachments(
  identifier: string,
  opts: { max?: number } = {},
): Promise<ListedAttachment[]> {
  const client = await linear();
  const upperId = identifier.toUpperCase();
  const nodes = await paginateRaw<AttachmentNode, AttachmentsPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_ATTACHMENTS_QUERY, {
        id: upperId,
        first,
        after,
      }) as Promise<AttachmentsPage>,
    (response) => {
      if (response.data.issue === null) {
        throw new NotFoundError(
          `issue not found: ${upperId}`,
          "verify the identifier (TEAM-NN) or your team scope",
        );
      }
      return response.data.issue.attachments ?? null;
    },
    { pageSize: 250, max: opts.max },
  );
  return nodes.map(shape);
}

export async function listAttachmentsPage(
  identifier: string,
  opts: { first: number; after?: string } = { first: 250 },
): Promise<{
  attachments: ListedAttachment[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}> {
  const client = await linear();
  const upperId = identifier.toUpperCase();
  const page = await paginateRawPage<AttachmentNode, AttachmentsPage>(
    ({ first, after }) =>
      client.client.rawRequest(LIST_ATTACHMENTS_QUERY, {
        id: upperId,
        first,
        after,
      }) as Promise<AttachmentsPage>,
    (response) => {
      if (response.data.issue === null) {
        throw new NotFoundError(
          `issue not found: ${upperId}`,
          "verify the identifier (TEAM-NN) or your team scope",
        );
      }
      return response.data.issue.attachments ?? null;
    },
    { limit: opts.first, after: opts.after, pageSize: 250 },
  );
  return {
    attachments: page.nodes.map(shape),
    pageInfo: page.pageInfo,
  };
}

export interface UpdateAttachmentInput {
  title?: string;
  /**
   * Linear's current AttachmentUpdateInput does not support URL changes.
   * Kept here so old CLI/MCP callers get a structured validation error
   * instead of an unknown GraphQL schema error.
   */
  url?: string;
}

const UPDATE_ATTACHMENT_MUTATION = /* GraphQL */ `
  mutation UpdateAttachment($id: String!, $input: AttachmentUpdateInput!) {
    attachmentUpdate(id: $id, input: $input) {
      success
      attachment {
        id
        title
        url
        sourceType
        metadata
        creator { id name email }
      }
    }
  }
`;

/**
 * Update an attachment's title. Idempotent at the value level —
 * retry-wrapped via withClient.
 */
export async function updateAttachment(
  id: string,
  input: UpdateAttachmentInput,
): Promise<ListedAttachment> {
  if (input.url !== undefined) {
    throw new ValidationError(
      "attachment URL cannot be updated by Linear's AttachmentUpdateInput",
      "delete the attachment and create a replacement with `lebop link` / `link_url_to_issue`",
    );
  }
  const linearInput: Record<string, unknown> = {};
  if (input.title !== undefined) linearInput.title = input.title;
  try {
    const response = (await withClient((c) =>
      c.client.rawRequest(UPDATE_ATTACHMENT_MUTATION, { id, input: linearInput }),
    )) as {
      data: { attachmentUpdate: { success: boolean; attachment: AttachmentNode } };
    };
    const attachment = requireMutationEntity<AttachmentNode>(
      "attachmentUpdate",
      response.data.attachmentUpdate,
      "attachment",
    );
    return shape(attachment);
  } catch (err) {
    throw mapSdkError(err);
  }
}

const DELETE_ATTACHMENT_MUTATION = /* GraphQL */ `
  mutation DeleteAttachment($id: String!) {
    attachmentDelete(id: $id) { success }
  }
`;

/**
 * Delete an attachment by UUID. NOT retry-wrapped — re-running after success
 * surfaces as not-found.
 */
export async function deleteAttachment(id: string): Promise<boolean> {
  const client = await linear();
  const response = (await client.client.rawRequest(DELETE_ATTACHMENT_MUTATION, { id })) as {
    data: { attachmentDelete: { success: boolean } };
  };
  requireMutationSuccess("attachmentDelete", response.data.attachmentDelete);
  return true;
}
