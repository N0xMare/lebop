/**
 * Attachment CRUD over Linear's Attachment type. An Attachment is a typed
 * link from an issue to an external resource (PR, design doc, calendar event,
 * etc.). The `attachmentLinkURL` mutation we already expose via `lebop link`
 * creates a URL-shaped attachment; this file owns the read + update + delete
 * paths so the surface is symmetric.
 *
 * Linear API surface used:
 *   - Issue.attachments connection (read)
 *   - attachmentUpdate(id, input) (update — title/url only)
 *   - attachmentDelete(id) (delete)
 */

import { mapSdkError, NotFoundError } from "./errors.ts";
import { paginateRaw } from "./paginate.ts";
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

/**
 * List all attachments on one issue. Paginates server-side; capped by the
 * standard `LEBOP_MAX_ITEMS` runtime safety bound. Throws NotFoundError if
 * the issue identifier doesn't resolve — matches the wave-1 `get_*` contract
 * (caller can re-shape to `null` at the MCP/CLI boundary if preferred).
 */
export async function listAttachments(identifier: string): Promise<ListedAttachment[]> {
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
    { pageSize: 250 },
  );
  return nodes.map(shape);
}

export interface UpdateAttachmentInput {
  title?: string;
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
 * Update an attachment's title and/or URL. Idempotent at the value level —
 * retry-wrapped via withClient.
 */
export async function updateAttachment(
  id: string,
  input: UpdateAttachmentInput,
): Promise<ListedAttachment> {
  const linearInput: Record<string, unknown> = {};
  if (input.title !== undefined) linearInput.title = input.title;
  if (input.url !== undefined) linearInput.url = input.url;
  try {
    const response = (await withClient((c) =>
      c.client.rawRequest(UPDATE_ATTACHMENT_MUTATION, { id, input: linearInput }),
    )) as {
      data: { attachmentUpdate: { success: boolean; attachment: AttachmentNode } };
    };
    return shape(response.data.attachmentUpdate.attachment);
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
  return response.data.attachmentDelete.success;
}
