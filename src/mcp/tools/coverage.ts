/**
 * P0/P1 coverage tools: search, history, views, custom fields.
 * Thin MCP adapters over surface operations.
 */

import { envelope } from "../../lib/envelope.ts";
import { mcpGetNext, mcpListNext } from "../../lib/nextStubs.ts";
import {
  buildCustomFieldGetIssueInputFromMcp,
  buildCustomFieldGetIssueMcpInputSchema,
  buildCustomFieldListInputFromMcp,
  buildCustomFieldListMcpInputSchema,
  buildCustomFieldSetIssueInputFromMcp,
  buildCustomFieldSetIssueMcpInputSchema,
  buildIssueHistoryListInputFromMcp,
  buildIssueHistoryListMcpInputSchema,
  buildSearchLinearInputFromMcp,
  buildSearchLinearMcpInputSchema,
  buildViewCreateInputFromMcp,
  buildViewCreateMcpInputSchema,
  buildViewDeleteInputFromMcp,
  buildViewDeleteMcpInputSchema,
  buildViewGetInput,
  buildViewGetMcpInputSchema,
  buildViewListInputFromMcp,
  buildViewListMcpInputSchema,
  buildViewMaterializeInputFromMcp,
  buildViewMaterializeMcpInputSchema,
  buildViewUpdateInputFromMcp,
  buildViewUpdateMcpInputSchema,
  type CustomFieldGetIssueMcpInput,
  type CustomFieldListMcpInput,
  type CustomFieldSetIssueMcpInput,
  customFieldGetIssueOperation,
  customFieldListOperation,
  customFieldSetIssueOperation,
  executeCustomFieldGetIssue,
  executeCustomFieldList,
  executeCustomFieldSetIssue,
  executeIssueHistoryList,
  executeSearchLinear,
  executeViewCreate,
  executeViewDelete,
  executeViewGet,
  executeViewList,
  executeViewMaterialize,
  executeViewUpdate,
  type IssueHistoryListMcpInput,
  issueHistoryListOperation,
  issueHistoryListPayload,
  type SearchLinearMcpInput,
  searchLinearOperation,
  type ViewCreateMcpInput,
  type ViewDeleteMcpInput,
  type ViewListMcpInput,
  type ViewMaterializeMcpInput,
  type ViewUpdateMcpInput,
  viewCreateOperation,
  viewDeleteOperation,
  viewGetOperation,
  viewListOperation,
  viewListPayload,
  viewMaterializeOperation,
  viewMaterializePayload,
  viewUpdateOperation,
} from "../../surface/coverage.ts";
import { text } from "../response.ts";
import type { McpToolSpec, ToolHandlerArgs } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface CoverageToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

export function buildCoverageToolSpecs(deps: CoverageToolDeps): McpToolSpec[] {
  return [
    {
      name: "search_linear",
      config: mcpToolConfig(
        searchLinearOperation,
        buildSearchLinearMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: SearchLinearMcpInput) => {
        const result = await executeSearchLinear(buildSearchLinearInputFromMcp(args));
        // Override lib default (CLI dialect) with MCP pure tool names.
        return text(
          envelope({
            ...(result as unknown as Record<string, unknown>),
            next: mcpGetNext("get_issue", "fetch_linear_workspace", "list_issues"),
          }),
        );
      },
    },
    {
      name: "list_issue_history",
      config: mcpToolConfig(
        issueHistoryListOperation,
        buildIssueHistoryListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: IssueHistoryListMcpInput) => {
        const result = await executeIssueHistoryList(buildIssueHistoryListInputFromMcp(args));
        const body = issueHistoryListPayload(result) as unknown as Record<string, unknown>;
        return text(
          envelope({
            ...body,
            next: mcpListNext(
              "list_issue_history",
              Boolean(result.has_more),
              result.next_cursor,
              mcpGetNext("get_issue", "list_comments"),
            ),
          }),
        );
      },
    },
    {
      name: "list_views",
      config: mcpToolConfig(
        viewListOperation,
        buildViewListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ViewListMcpInput) => {
        const result = await executeViewList(buildViewListInputFromMcp(args));
        return text(
          envelope({
            ...viewListPayload(result),
            next: mcpGetNext("get_view", "materialize_view"),
          }),
        );
      },
    },
    {
      name: "get_view",
      config: mcpToolConfig(
        viewGetOperation,
        buildViewGetMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ToolHandlerArgs) => {
        const view = await executeViewGet(buildViewGetInput(args.id as string));
        return text(
          envelope({ view, next: mcpGetNext("materialize_view", "update_view", "list_views") }),
        );
      },
    },
    {
      name: "create_view",
      config: mcpToolConfig(
        viewCreateOperation,
        buildViewCreateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ViewCreateMcpInput) => {
        const view = await executeViewCreate(buildViewCreateInputFromMcp(args));
        return text(envelope({ view, next: mcpGetNext("materialize_view", "get_view") }));
      },
    },
    {
      name: "update_view",
      config: mcpToolConfig(
        viewUpdateOperation,
        buildViewUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ViewUpdateMcpInput) => {
        const view = await executeViewUpdate(buildViewUpdateInputFromMcp(args));
        return text(envelope({ view, next: mcpGetNext("materialize_view", "get_view") }));
      },
    },
    {
      name: "delete_view",
      config: mcpToolConfig(
        viewDeleteOperation,
        buildViewDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ViewDeleteMcpInput) => {
        deps.requireConfirm(args, "delete_view");
        const result = await executeViewDelete(buildViewDeleteInputFromMcp(args));
        return text(envelope({ ...result, next: mcpGetNext("list_views") }));
      },
    },
    {
      name: "materialize_view",
      config: mcpToolConfig(
        viewMaterializeOperation,
        buildViewMaterializeMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ViewMaterializeMcpInput) => {
        const result = await executeViewMaterialize(buildViewMaterializeInputFromMcp(args));
        const body = viewMaterializePayload(result);
        return text(
          envelope({
            ...(body as unknown as Record<string, unknown>),
            next: mcpListNext(
              "materialize_view",
              Boolean(body.has_more),
              body.next_cursor,
              mcpGetNext("get_issue", "list_issues"),
            ),
          }),
        );
      },
    },
    {
      name: "list_custom_fields",
      config: mcpToolConfig(
        customFieldListOperation,
        buildCustomFieldListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CustomFieldListMcpInput) => {
        const result = await executeCustomFieldList(buildCustomFieldListInputFromMcp(args));
        return text(
          envelope({
            ...(result as unknown as Record<string, unknown>),
            next: mcpGetNext("get_issue_custom_fields", "get_issue"),
          }),
        );
      },
    },
    {
      name: "get_issue_custom_fields",
      config: mcpToolConfig(
        customFieldGetIssueOperation,
        buildCustomFieldGetIssueMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CustomFieldGetIssueMcpInput) => {
        const result = await executeCustomFieldGetIssue(buildCustomFieldGetIssueInputFromMcp(args));
        return text(
          envelope({
            ...(result as unknown as Record<string, unknown>),
            next: mcpGetNext("set_issue_custom_field", "get_issue"),
          }),
        );
      },
    },
    {
      name: "set_issue_custom_field",
      config: mcpToolConfig(
        customFieldSetIssueOperation,
        buildCustomFieldSetIssueMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CustomFieldSetIssueMcpInput) => {
        const result = await executeCustomFieldSetIssue(buildCustomFieldSetIssueInputFromMcp(args));
        return text(
          envelope({
            ...(result as unknown as Record<string, unknown>),
            next: mcpGetNext("get_issue_custom_fields", "get_issue"),
          }),
        );
      },
    },
  ];
}
