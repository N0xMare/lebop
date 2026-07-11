import { envelope } from "../../lib/envelope.ts";
import {
  buildDocumentCreateInputFromMcp,
  buildDocumentCreateMcpInputSchema,
  buildDocumentDeleteInputFromMcp,
  buildDocumentDeleteMcpInputSchema,
  buildDocumentGetInput,
  buildDocumentGetMcpInputSchema,
  buildDocumentListInputFromMcp,
  buildDocumentListMcpInputSchema,
  buildDocumentUpdateInputFromMcp,
  buildDocumentUpdateMcpInputSchema,
  DOCUMENT_MCP_GET_HINT,
  DOCUMENT_MCP_PROJECT_NOT_FOUND_HINT,
  type DocumentCreateMcpInput,
  type DocumentDeleteMcpInput,
  type DocumentListMcpInput,
  type DocumentUpdateMcpInput,
  documentCreateOperation,
  documentDeleteOperation,
  documentDeleteSuccessForMcp,
  documentGetOperation,
  documentListOperation,
  documentListPayload,
  documentUpdateOperation,
  executeDocumentCreate,
  executeDocumentDelete,
  executeDocumentGet,
  executeDocumentList,
  executeDocumentUpdate,
} from "../../surface/documents.ts";
import { text } from "../response.ts";
import type { McpToolSpec, ToolHandlerArgs } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface DocumentToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

export function buildDocumentToolSpecs(deps: DocumentToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_documents",
      config: mcpToolConfig(
        documentListOperation,
        buildDocumentListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: DocumentListMcpInput) => {
        const result = await executeDocumentList(buildDocumentListInputFromMcp(args), {
          projectNotFoundHint: DOCUMENT_MCP_PROJECT_NOT_FOUND_HINT,
        });
        return text(envelope(documentListPayload(result)));
      },
    },
    {
      name: "get_document",
      config: mcpToolConfig(
        documentGetOperation,
        buildDocumentGetMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ToolHandlerArgs) => {
        const document = await executeDocumentGet(
          buildDocumentGetInput(args.id as string),
          DOCUMENT_MCP_GET_HINT,
        );
        return text(envelope({ document }));
      },
    },
    {
      name: "create_document",
      config: mcpToolConfig(
        documentCreateOperation,
        buildDocumentCreateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: DocumentCreateMcpInput) => {
        const document = await executeDocumentCreate(buildDocumentCreateInputFromMcp(args));
        return text(envelope({ document }));
      },
    },
    {
      name: "update_document",
      config: mcpToolConfig(
        documentUpdateOperation,
        buildDocumentUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: DocumentUpdateMcpInput) => {
        const document = await executeDocumentUpdate(buildDocumentUpdateInputFromMcp(args));
        return text(envelope({ document }));
      },
    },
    {
      name: "delete_document",
      config: mcpToolConfig(
        documentDeleteOperation,
        buildDocumentDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: DocumentDeleteMcpInput) => {
        deps.requireConfirm(args, "delete_document");
        const result = await executeDocumentDelete(buildDocumentDeleteInputFromMcp(args));
        return text(
          envelope({
            id: result.id,
            status: result.status,
            success: documentDeleteSuccessForMcp(result),
          }),
        );
      },
    },
  ];
}
