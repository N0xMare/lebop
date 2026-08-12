import { z } from "zod";
import { buildComments, buildIssueMetadata } from "../lib/build.ts";
import {
  type AppliedContentField,
  applyContentPolicy,
  contentFieldMeta,
} from "../lib/contentSize.ts";
import { tryMapToNull } from "../lib/errors.ts";
import type { FetchedIssue } from "../lib/issues.ts";
import {
  buildPullIssuesQuery,
  completeInlineIssueComments,
  type IssueCommentsRawRequest,
} from "../lib/pullQuery.ts";
import { withClient } from "../lib/sdk.ts";
import { isUuid } from "../lib/uuid.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

export interface IssueGetInput {
  identifier: string;
  includeComments: boolean;
  includeRelations: boolean;
  /** Full description on wire (bypass size cap). */
  fullContent: boolean;
  /** Write full description to this path; wire stays dense. */
  contentFile?: string;
}

export interface IssueGetCliInput {
  id: string;
  opts: {
    comments?: boolean;
    relations?: boolean;
    fullContent?: boolean;
    contentFile?: string;
  };
}

export type IssueGetMcpInput = Record<string, unknown> & {
  identifier: string;
  include_comments?: boolean;
  include_relations?: boolean;
  full_content?: boolean;
  content_file?: string;
};

export interface IssueContextCompleteness {
  comments?: {
    complete: boolean;
    has_more: boolean;
    next_cursor: string | null;
    count: number;
  };
  relations?: {
    complete: boolean;
    has_more: boolean;
    next_cursor: { outbound: string | null; inbound: string | null };
    continuation?: {
      tool: "list_relations";
      arguments: { identifier: string };
      reason: string;
    };
    outbound_count: number;
    inbound_count: number;
  };
}

export interface IssueContext {
  metadata: ReturnType<typeof buildIssueMetadata>["metadata"];
  description: string;
  comments?: ReturnType<typeof buildComments>;
  relations?: ReturnType<typeof buildIssueRelationSummary>;
  completeness: IssueContextCompleteness;
  /** Content-size control plane (description field). */
  content?: {
    description_truncated: boolean;
    description_original_bytes: number;
    description_limit_bytes: number;
    body_source: AppliedContentField["body_source"];
    content_file?: string;
    content_bytes?: number;
    hint?: string;
  };
}

const issueGetCanonicalSchema: z.ZodType<IssueGetInput> = z
  .object({
    identifier: z.string(),
    includeComments: z.boolean(),
    includeRelations: z.boolean(),
    fullContent: z.boolean(),
    contentFile: z.string().optional(),
  })
  .strict();

export function buildIssueGetInputFromCli(input: IssueGetCliInput): IssueGetInput {
  // 0.0.6 dense default: comments off unless --comments; relations on for shell.
  return parseSurfaceInput("issues.get", issueGetCanonicalSchema, {
    identifier: input.id,
    includeComments: input.opts.comments === true,
    includeRelations: input.opts.relations !== false,
    fullContent: input.opts.fullContent === true,
    contentFile: input.opts.contentFile?.trim() || undefined,
  });
}

export function buildIssueGetInputFromMcp(input: IssueGetMcpInput): IssueGetInput {
  // 0.0.6 dense default: comments/relations off unless explicitly true.
  return parseSurfaceInput("issues.get", issueGetCanonicalSchema, {
    identifier: input.identifier,
    includeComments: input.include_comments === true,
    includeRelations: input.include_relations === true,
    fullContent: input.full_content === true,
    contentFile:
      typeof input.content_file === "string" && input.content_file.trim()
        ? input.content_file.trim()
        : undefined,
  });
}

export async function executeIssueGet(input: IssueGetInput): Promise<IssueContext | null> {
  const idLooksUuid = isUuid(input.identifier);
  const normalizedId = idLooksUuid ? input.identifier : input.identifier.toUpperCase();
  const query = buildPullIssuesQuery([normalizedId], input.includeComments, input.includeRelations);
  return tryMapToNull(async () => {
    const response = (await withClient((c) => c.client.rawRequest(query))) as {
      data: Record<string, FetchedIssue | null>;
    };
    const issue = response.data.a0;
    if (!issue) return null;
    if (input.includeComments) {
      await completeInlineIssueComments(
        (query, variables) =>
          withClient((c) =>
            c.client.rawRequest(query, variables),
          ) as ReturnType<IssueCommentsRawRequest>,
        [issue],
      );
    }

    const { metadata, description } = buildIssueMetadata(issue);
    const applied = await applyContentPolicy({
      text: description,
      fullContent: input.fullContent,
      contentFile: input.contentFile,
    });
    let comments = input.includeComments ? buildComments(issue) : undefined;
    if (comments && !input.fullContent && !input.contentFile) {
      // Cap each comment body under the same per-field limit (wire only).
      comments = await Promise.all(
        comments.map(async (c) => {
          const bodyApplied = await applyContentPolicy({ text: c.body });
          return { ...c, body: bodyApplied.value };
        }),
      );
    }

    const contentMeta = contentFieldMeta(applied);
    return {
      metadata,
      description: applied.value,
      ...(comments ? { comments } : {}),
      ...(input.includeRelations ? { relations: buildIssueRelationSummary(issue) } : {}),
      completeness: buildIssueCompleteness(issue, {
        includeComments: input.includeComments,
        includeRelations: input.includeRelations,
      }),
      content: {
        description_truncated: Boolean(contentMeta.description_truncated),
        description_original_bytes: contentMeta.description_original_bytes as number,
        description_limit_bytes: contentMeta.description_limit_bytes as number,
        body_source: contentMeta.body_source as AppliedContentField["body_source"],
        ...(typeof contentMeta.content_file === "string"
          ? {
              content_file: contentMeta.content_file,
              content_bytes: contentMeta.content_bytes as number,
            }
          : {}),
        ...(typeof contentMeta.hint === "string" ? { hint: contentMeta.hint } : {}),
      },
    };
  });
}

function buildIssueRelationSummary(issue: FetchedIssue): {
  outbound: { id: string; type: string; identifier: string; title: string }[];
  inbound: { id: string; type: string; identifier: string; title: string }[];
} {
  return {
    outbound: (issue.relations?.nodes ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      identifier: r.relatedIssue.identifier,
      title: r.relatedIssue.title,
    })),
    inbound: (issue.inverseRelations?.nodes ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      identifier: r.issue.identifier,
      title: r.issue.title,
    })),
  };
}

function buildIssueCompleteness(
  issue: FetchedIssue,
  options: { includeComments: boolean; includeRelations: boolean },
): IssueContextCompleteness {
  const out: IssueContextCompleteness = {};
  if (options.includeComments) {
    const pageInfo = issue.comments?.pageInfo ?? { hasNextPage: false, endCursor: null };
    out.comments = {
      complete: !pageInfo.hasNextPage,
      has_more: pageInfo.hasNextPage,
      next_cursor: pageInfo.endCursor ?? null,
      count: issue.comments?.nodes.length ?? 0,
    };
  }
  if (options.includeRelations) {
    const outbound = issue.relations?.pageInfo ?? { hasNextPage: false, endCursor: null };
    const inbound = issue.inverseRelations?.pageInfo ?? { hasNextPage: false, endCursor: null };
    const hasMore = outbound.hasNextPage || inbound.hasNextPage;
    out.relations = {
      complete: !outbound.hasNextPage && !inbound.hasNextPage,
      has_more: hasMore,
      next_cursor: {
        outbound: outbound.endCursor ?? null,
        inbound: inbound.endCursor ?? null,
      },
      ...(hasMore
        ? {
            continuation: {
              tool: "list_relations" as const,
              arguments: { identifier: issue.identifier },
              reason:
                "get_issue returns bounded relation summaries; call list_relations for the complete relation graph.",
            },
          }
        : {}),
      outbound_count: issue.relations?.nodes.length ?? 0,
      inbound_count: issue.inverseRelations?.nodes.length ?? 0,
    };
  }
  return out;
}

export function buildIssueGetMcpInputSchema(workspaceParamDescription: string) {
  return {
    identifier: z.string().describe("Issue identifier or UUID, e.g. 'TEAM-321'."),
    include_comments: z
      .boolean()
      .optional()
      .describe(
        "Default false (dense). Set true to include comments, matching `lebop show --comments`.",
      ),
    include_relations: z
      .boolean()
      .optional()
      .describe("Default false (dense). Set true to include outbound/inbound relation summaries."),
    full_content: z
      .boolean()
      .optional()
      .describe(
        "Default false. When true, return full description on the wire (bypass 64 KiB agent size cap).",
      ),
    content_file: z
      .string()
      .optional()
      .describe(
        "Write full description to this path; wire stays dense (prefer for large bodies). Agents should Read the file.",
      ),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export const issueGetOperation = {
  id: "issues.get",
  domain: "issues",
  resource: "issue",
  action: "get",
  title: "Get a single Linear issue",
  description:
    "Get issue by id/UUID. Dense shell (meta+description; 64 KiB default cap). Prefer content_file for large bodies; full_content for full wire. comments/relations off unless include_*=true.",
  cli: { command: "show", liveSteps: ["cli:show --json"] },
  mcp: {
    tool: "get_issue",
    profile: "core",
    title: "Get a single Linear issue",
    description:
      "Get issue by id/UUID. Dense shell with 64 KiB description cap; content_file preferred for large bodies; full_content for full wire. include_comments/include_relations default false.",
    annotations: {
      title: "Get a single Linear issue",
      // content_file writes the host filesystem — not a pure read-only tool.
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  notes:
    "content_file writes host FS (not confined to LEBOP_HOME). Prefer project dir or /tmp. Not pure read-only while content_file is supported.",
  fromCli: buildIssueGetInputFromCli,
  fromMcp: buildIssueGetInputFromMcp,
} satisfies SurfaceOperationContract<
  IssueGetInput,
  IssueContext | null,
  IssueGetCliInput,
  IssueGetMcpInput
>;
