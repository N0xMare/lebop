import { z } from "zod";
import {
  deleteAttachment,
  type ListedAttachment,
  listAttachments,
  type UpdateAttachmentInput,
  updateAttachment,
} from "../lib/attachments.ts";
import { tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

export interface AttachmentListInput {
  identifier: string;
}

export interface AttachmentListCliInput {
  issue: string;
}

export type AttachmentListMcpInput = Record<string, unknown> & {
  identifier: string;
};

export interface AttachmentListResult {
  identifier: string;
  count: number;
  attachments: ListedAttachment[];
}

export interface AttachmentUpdateCanonicalInput {
  id: string;
  update: UpdateAttachmentInput;
}

export interface AttachmentUpdateCliInput {
  id: string;
  opts: {
    title?: string;
    url?: string;
  };
}

export type AttachmentUpdateMcpInput = Record<string, unknown> & {
  id: string;
  title?: string;
  url?: string;
};

export interface AttachmentUpdateResult {
  attachment: ListedAttachment;
}

export interface AttachmentDeleteInput {
  id: string;
}

export interface AttachmentDeleteCliInput {
  id: string;
  opts: {
    yes?: boolean;
  };
}

export type AttachmentDeleteMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
};

export interface AttachmentDeleteResult {
  id: string;
  status: "deleted" | "already-absent";
  success: boolean;
}

const attachmentListCanonicalSchema = z.object({ identifier: z.string().min(1) }).strict();

const attachmentUpdateCanonicalSchema = z
  .object({
    id: z.string().min(1),
    update: z
      .object({
        title: z.string().optional(),
        url: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const attachmentDeleteCanonicalSchema = z.object({ id: z.string().min(1) }).strict();

export function buildAttachmentListInputFromCli(
  input: AttachmentListCliInput,
): AttachmentListInput {
  return parseSurfaceInput("attachments.list", attachmentListCanonicalSchema, {
    identifier: input.issue,
  });
}

export function buildAttachmentListInputFromMcp(
  input: AttachmentListMcpInput,
): AttachmentListInput {
  return parseSurfaceInput("attachments.list", attachmentListCanonicalSchema, {
    identifier: input.identifier,
  });
}

export function buildAttachmentUpdateInputFromCli(
  input: AttachmentUpdateCliInput,
): AttachmentUpdateCanonicalInput {
  const update: UpdateAttachmentInput = {};
  if (input.opts.title !== undefined) update.title = input.opts.title;
  if (input.opts.url !== undefined) update.url = input.opts.url;
  if (Object.keys(update).length === 0) {
    throw new ValidationError("nothing to update", "pass --title or --url");
  }
  return parseSurfaceInput("attachments.update", attachmentUpdateCanonicalSchema, {
    id: input.id,
    update,
  });
}

export function buildAttachmentUpdateInputFromMcp(
  input: AttachmentUpdateMcpInput,
): AttachmentUpdateCanonicalInput {
  const update: UpdateAttachmentInput = {};
  if (input.title !== undefined) update.title = input.title;
  if (input.url !== undefined) update.url = input.url;
  if (Object.keys(update).length === 0) {
    throw new ValidationError(
      "nothing to update — pass at least one of title, url",
      "pass title and/or url",
    );
  }
  return parseSurfaceInput("attachments.update", attachmentUpdateCanonicalSchema, {
    id: input.id,
    update,
  });
}

export function buildAttachmentDeleteInputFromCli(
  input: AttachmentDeleteCliInput,
): AttachmentDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to delete attachment ${input.id} without --yes`,
      "re-run with --yes to confirm. This operation is irreversible.",
    );
  }
  return parseSurfaceInput("attachments.delete", attachmentDeleteCanonicalSchema, {
    id: input.id,
  });
}

export function buildAttachmentDeleteInputFromMcp(
  input: AttachmentDeleteMcpInput,
): AttachmentDeleteInput {
  return parseSurfaceInput("attachments.delete", attachmentDeleteCanonicalSchema, {
    id: input.id,
  });
}

export async function executeAttachmentList(
  input: AttachmentListInput,
): Promise<AttachmentListResult> {
  const identifier = input.identifier.toUpperCase();
  const attachments = await listAttachments(identifier);
  return {
    identifier,
    count: attachments.length,
    attachments,
  };
}

export async function executeAttachmentUpdate(
  input: AttachmentUpdateCanonicalInput,
): Promise<AttachmentUpdateResult> {
  const attachment = await updateAttachment(input.id, input.update);
  return { attachment };
}

export async function executeAttachmentDelete(
  input: AttachmentDeleteInput,
): Promise<AttachmentDeleteResult> {
  const r = await tryIdempotentDelete(() => deleteAttachment(input.id));
  return {
    id: input.id,
    status: r.status,
    success: r.status === "deleted" && Boolean(r.result),
  };
}

export const attachmentListOperation = {
  id: "attachments.list",
  domain: "attachments",
  resource: "attachment",
  action: "list",
  title: "List attachments on an issue",
  description:
    "Returns all Linear Attachments on one issue (URL links, integration-created references, etc.). Pure read; paginated server-side.",
  cli: {
    command: "attachment list",
    liveSteps: ["cli:attachment list --json"],
  },
  mcp: {
    tool: "list_attachments",
    title: "List attachments on an issue",
    description:
      "Returns all Linear Attachments on one issue (URL links, integration-created references, etc.). Pure read; paginated server-side.",
    annotations: {
      title: "List attachments on an issue",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["identifier", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildAttachmentListInputFromCli,
  fromMcp: buildAttachmentListInputFromMcp,
  execute: executeAttachmentList,
} satisfies SurfaceOperationContract<
  AttachmentListInput,
  AttachmentListResult,
  AttachmentListCliInput,
  AttachmentListMcpInput
>;

export const attachmentUpdateOperation = {
  id: "attachments.update",
  domain: "attachments",
  resource: "attachment",
  action: "update",
  title: "Update an attachment's title",
  description:
    "Update an attachment's title. Linear does not support URL edits on existing attachments; delete and relink to change the URL.",
  cli: {
    command: "attachment update",
    liveSteps: ["cli:attachment update --json", "cli:attachment update url unsupported --json"],
  },
  mcp: {
    tool: "update_attachment",
    title: "Update an attachment's title",
    description:
      "Update an attachment's title. Linear does not support URL edits on existing attachments; delete and relink to change the URL.",
    annotations: {
      title: "Update an attachment's title",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "title", "url", "workspace"],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildAttachmentUpdateInputFromCli,
  fromMcp: buildAttachmentUpdateInputFromMcp,
  execute: executeAttachmentUpdate,
} satisfies SurfaceOperationContract<
  AttachmentUpdateCanonicalInput,
  AttachmentUpdateResult,
  AttachmentUpdateCliInput,
  AttachmentUpdateMcpInput
>;

export const attachmentDeleteOperation = {
  id: "attachments.delete",
  domain: "attachments",
  resource: "attachment",
  action: "delete",
  title: "Delete an attachment",
  description:
    "Delete an attachment by UUID. Idempotent — re-deleting an already-absent attachment returns `{status: 'already-absent'}`.",
  cli: {
    command: "attachment delete",
    liveSteps: ["cli:attachment delete --json"],
  },
  mcp: {
    tool: "delete_attachment",
    title: "Delete an attachment",
    description:
      "Delete an attachment by UUID. Idempotent — re-deleting an already-absent attachment returns `{status: 'already-absent'}`.",
    annotations: {
      title: "Delete an attachment",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "confirm", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildAttachmentDeleteInputFromCli,
  fromMcp: buildAttachmentDeleteInputFromMcp,
  execute: executeAttachmentDelete,
} satisfies SurfaceOperationContract<
  AttachmentDeleteInput,
  AttachmentDeleteResult,
  AttachmentDeleteCliInput,
  AttachmentDeleteMcpInput
>;

export const ATTACHMENT_SURFACE_OPERATIONS = [
  attachmentListOperation,
  attachmentUpdateOperation,
  attachmentDeleteOperation,
] as const;

export function buildAttachmentListMcpInputSchema(workspaceDescription: string) {
  return {
    identifier: z.string().describe("Issue identifier, e.g. 'NOX-321'."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildAttachmentUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Attachment UUID."),
    title: z.string().optional(),
    url: z
      .string()
      .optional()
      .describe("Unsupported by Linear; kept to return a structured validation error."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildAttachmentDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Attachment UUID."),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}
