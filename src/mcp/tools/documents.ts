import { envelope } from "../../lib/envelope.ts";
import { mcpGetNext } from "../../lib/nextStubs.ts";
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
        return text(
          envelope({
            ...documentListPayload(result),
            next: mcpGetNext("get_document", "create_document"),
          }),
        );
      },
    },
    {
      name: "get_document",
      config: mcpToolConfig(
        documentGetOperation,
        buildDocumentGetMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ToolHandlerArgs) => {
        const { mcpEntityTruncatedNext } = await import("../../lib/nextStubs.ts");
        const { document, content, truncated } = await executeDocumentGet(
          buildDocumentGetInput(args.id as string, {
            fullContent: args.full_content === true,
            contentFile: typeof args.content_file === "string" ? args.content_file : undefined,
          }),
          DOCUMENT_MCP_GET_HINT,
        );
        return text(
          envelope({
            document,
            content,
            next: truncated
              ? mcpEntityTruncatedNext("get_document", `id=${args.id}`)
              : mcpGetNext("update_document", "list_documents"),
          }),
        );
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
        return text(envelope({ document, next: mcpGetNext("get_document", "list_documents") }));
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
        return text(envelope({ document, next: mcpGetNext("get_document", "list_documents") }));
      },
    },
    {
      name: "soft_delete_document",
      config: mcpToolConfig(
        documentDeleteOperation,
        buildDocumentDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: DocumentDeleteMcpInput) => {
        deps.requireConfirm(args, "soft_delete_document");
        const result = await executeDocumentDelete(buildDocumentDeleteInputFromMcp(args));
        return text(
          envelope({
            id: result.id,
            status: result.status,
            success: documentDeleteSuccessForMcp(result),
            next: mcpGetNext("list_documents"),
          }),
        );
      },
    },
  ];
}
