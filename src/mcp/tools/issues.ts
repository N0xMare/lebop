import { envelope } from "../../lib/envelope.ts";
import { projectListedIssuesResult } from "../../lib/listIssues.ts";
import { mcpGetIssueTruncatedNext, mcpGetNext, mcpListNext } from "../../lib/nextStubs.ts";
import {
  buildIssueArchiveInputFromMcp,
  buildIssueArchiveMcpInputSchema,
  buildIssueBulkUpdateInputFromMcp,
  buildIssueBulkUpdateMcpInputSchema,
  buildIssueCreateInputFromMcp,
  buildIssueCreateMcpInputSchema,
  buildIssueGetInputFromMcp,
  buildIssueGetMcpInputSchema,
  buildIssueListInputFromMcp,
  buildIssueListMcpInputSchema,
  buildIssueUnarchiveInputFromMcp,
  buildIssueUnarchiveMcpInputSchema,
  buildIssueUpdateInputFromMcp,
  buildIssueUpdateMcpInputSchema,
  executeIssueArchive,
  executeIssueBulkUpdate,
  executeIssueCreate,
  executeIssueGet,
  executeIssueList,
  executeIssueUnarchive,
  executeIssueUpdate,
  type IssueBulkUpdateMcpInput,
  type IssueCreateDeps,
  type IssueCreateMcpInput,
  type IssueGetMcpInput,
  type IssueLifecycleMcpInput,
  type IssueListDeps,
  type IssueListMcpInput,
  type IssueRepoCacheDeps,
  type IssueUpdateMcpInput,
  issueArchiveOperation,
  issueBulkUpdateOperation,
  issueCreateOperation,
  issueGetOperation,
  issueListOperation,
  issueListPayload,
  issueUnarchiveOperation,
  issueUpdateOperation,
} from "../../surface/issues.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface IssueToolDeps extends IssueListDeps, IssueCreateDeps, IssueRepoCacheDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
  requireMcpEntity: <T>(value: T | null | undefined, label: string, id: string, hint?: string) => T;
}

export function buildIssueListToolSpecs(deps: IssueToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_issues",
      config: mcpToolConfig(
        issueListOperation,
        buildIssueListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: IssueListMcpInput) => {
        const result = await executeIssueList(buildIssueListInputFromMcp(args), deps);
        const { issues: slimIssues, fields } = projectListedIssuesResult(result, args.fields);
        const listBody = issueListPayload({
          ...result,
          issues: slimIssues as typeof result.issues,
        });
        return text(
          envelope({
            ...listBody,
            fields,
            next: mcpListNext("list_issues", Boolean(result.truncated), result.next_cursor, [
              "get_issue",
              "list_issues fields=full",
            ]),
          }),
        );
      },
    },
  ];
}

export function buildIssueLifecycleToolSpecs(deps: IssueToolDeps): McpToolSpec[] {
  return [
    {
      name: "get_issue",
      config: mcpToolConfig(
        issueGetOperation,
        buildIssueGetMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: IssueGetMcpInput) => {
        const issue = await executeIssueGet(buildIssueGetInputFromMcp(args));
        const entity = deps.requireMcpEntity(
          issue,
          "issue",
          args.identifier,
          "verify the issue identifier/UUID; run list_issues to discover issues",
        );
        const truncated = entity.content?.description_truncated === true;
        return text(
          envelope({
            issue: entity,
            ...(entity.content ? { content: entity.content } : {}),
            next: truncated
              ? mcpGetIssueTruncatedNext(entity.metadata.identifier)
              : mcpGetNext("list_comments", "update_issue", "list_issue_history"),
          }),
        );
      },
    },
    {
      name: "create_issue",
      config: mcpToolConfig(
        issueCreateOperation,
        buildIssueCreateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: IssueCreateMcpInput) =>
        text(
          envelope({
            ...(await executeIssueCreate(buildIssueCreateInputFromMcp(args), deps)),
            next: mcpGetNext("get_issue", "list_comments", "update_issue"),
          }),
        ),
    },
    {
      name: "update_issue",
      config: mcpToolConfig(
        issueUpdateOperation,
        buildIssueUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: IssueUpdateMcpInput) =>
        text(
          envelope({
            ...(await executeIssueUpdate(buildIssueUpdateInputFromMcp(args), deps)),
            next: mcpGetNext("get_issue", "list_comments"),
          }),
        ),
    },
    {
      name: "archive_issue",
      config: mcpToolConfig(
        issueArchiveOperation,
        buildIssueArchiveMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: IssueLifecycleMcpInput & { confirm?: boolean }) => {
        deps.requireConfirm(args, "archive_issue");
        return text(
          envelope({
            ...(await executeIssueArchive(buildIssueArchiveInputFromMcp(args), deps)),
            next: mcpGetNext("unarchive_issue", "list_issues"),
          }),
        );
      },
    },
    {
      name: "unarchive_issue",
      config: mcpToolConfig(
        issueUnarchiveOperation,
        buildIssueUnarchiveMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: IssueLifecycleMcpInput) =>
        text(
          envelope({
            ...(await executeIssueUnarchive(buildIssueUnarchiveInputFromMcp(args), deps)),
            next: mcpGetNext("get_issue", "list_issues"),
          }),
        ),
    },
  ];
}

export function buildIssueBulkToolSpecs(deps: IssueToolDeps): McpToolSpec[] {
  return [
    {
      name: "bulk_update_issues",
      config: mcpToolConfig(
        issueBulkUpdateOperation,
        buildIssueBulkUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: IssueBulkUpdateMcpInput) => {
        if (args.dry_run !== true) deps.requireConfirm(args, "bulk_update_issues");
        return text(
          envelope({
            ...(await executeIssueBulkUpdate(buildIssueBulkUpdateInputFromMcp(args, deps))),
          }),
        );
      },
    },
  ];
}
