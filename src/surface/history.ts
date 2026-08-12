/**
 * Issue history surface — dense field changelog (not comments).
 */

import { z } from "zod";
import { parseCliLimit } from "../lib/cliOptions.ts";
import { type IssueHistoryResult, listIssueHistory } from "../lib/issueHistory.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

// ── Issue history ───────────────────────────────────────────────────────────

export interface IssueHistoryListInput {
  identifier: string;
  since?: string;
  limit: number;
  after?: string;
}

export interface IssueHistoryListCliInput {
  id: string;
  opts: { since?: string; limit?: string; cursor?: string };
}

export type IssueHistoryListMcpInput = Record<string, unknown> & {
  identifier: string;
  since?: string;
  limit?: number;
  cursor?: string;
};

const issueHistoryListCanonicalSchema = z
  .object({
    identifier: z.string(),
    since: z.string().optional(),
    limit: z.number().int().positive(),
    after: z.string().optional(),
  })
  .strict();

export function buildIssueHistoryListInputFromCli(
  input: IssueHistoryListCliInput,
): IssueHistoryListInput {
  return parseSurfaceInput("history.list", issueHistoryListCanonicalSchema, {
    identifier: input.id,
    since: input.opts.since,
    limit: parseCliLimit(input.opts.limit, { defaultValue: 50 }),
    after: input.opts.cursor,
  });
}

export function buildIssueHistoryListInputFromMcp(
  input: IssueHistoryListMcpInput,
): IssueHistoryListInput {
  return parseSurfaceInput("history.list", issueHistoryListCanonicalSchema, {
    identifier: input.identifier,
    since: input.since,
    limit: input.limit ?? 50,
    after: input.cursor,
  });
}

export async function executeIssueHistoryList(
  input: IssueHistoryListInput,
): Promise<IssueHistoryResult> {
  return listIssueHistory({
    identifier: input.identifier,
    since: input.since,
    limit: input.limit,
    after: input.after,
  });
}

export function issueHistoryListPayload(result: IssueHistoryResult) {
  return {
    identifier: result.identifier,
    count: result.count,
    has_more: result.has_more,
    next_cursor: result.next_cursor,
    truncated: result.truncated,
    history: result.history,
    next: result.next,
  };
}

export const issueHistoryListOperation = {
  id: "history.list",
  domain: "history",
  resource: "issue_history",
  action: "list",
  title: "List issue history",
  description:
    "Dense field changelog for an issue (not comments). Use since for restart recovery.",
  cli: {
    command: "history",
    liveSteps: ["cli:history --json"],
  },
  mcp: {
    tool: "list_issue_history",
      profile: "core",
    title: "List issue history",
    description:
      "Dense field changelog for an issue (not comments). Use since for restart recovery.",
    annotations: {
      title: "List issue history",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildIssueHistoryListInputFromCli,
  fromMcp: buildIssueHistoryListInputFromMcp,
  execute: executeIssueHistoryList,
} satisfies SurfaceOperationContract<
  IssueHistoryListInput,
  IssueHistoryResult,
  IssueHistoryListCliInput,
  IssueHistoryListMcpInput
>;

export function buildIssueHistoryListMcpInputSchema(workspaceDescription: string) {
  return {
    identifier: z.string(),
    since: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}
