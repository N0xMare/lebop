import { envelope } from "../../lib/envelope.ts";
import {
  type AttachmentDeleteMcpInput,
  type AttachmentListMcpInput,
  type AttachmentUpdateMcpInput,
  attachmentDeleteOperation,
  attachmentListOperation,
  attachmentUpdateOperation,
  buildAttachmentDeleteInputFromMcp,
  buildAttachmentDeleteMcpInputSchema,
  buildAttachmentListInputFromMcp,
  buildAttachmentListMcpInputSchema,
  buildAttachmentUpdateInputFromMcp,
  buildAttachmentUpdateMcpInputSchema,
  executeAttachmentDelete,
  executeAttachmentList,
  executeAttachmentUpdate,
} from "../../surface/attachments.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface AttachmentToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

export function buildAttachmentsToolSpecs(deps: AttachmentToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_attachments",
      config: mcpToolConfig(
        attachmentListOperation,
        buildAttachmentListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: AttachmentListMcpInput) => {
        const result = await executeAttachmentList(buildAttachmentListInputFromMcp(args));
        return text(envelope({ ...result }));
      },
    },
    {
      name: "update_attachment",
      config: mcpToolConfig(
        attachmentUpdateOperation,
        buildAttachmentUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: AttachmentUpdateMcpInput) => {
        const result = await executeAttachmentUpdate(buildAttachmentUpdateInputFromMcp(args));
        return text(envelope({ ...result }));
      },
    },
    {
      name: "delete_attachment",
      config: mcpToolConfig(
        attachmentDeleteOperation,
        buildAttachmentDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: AttachmentDeleteMcpInput) => {
        deps.requireConfirm(args, "delete_attachment");
        const result = await executeAttachmentDelete(buildAttachmentDeleteInputFromMcp(args));
        return text(envelope({ id: result.id, status: result.status, success: result.success }));
      },
    },
  ];
}
