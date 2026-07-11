import { z } from "zod";
import {
  type LinkedUrlAttachment,
  type LinkUrlAttachmentResult,
  linkUrlAttachment,
} from "../lib/attachments.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

// ---------------------------------------------------------------------------
// Canonical inputs / results
// ---------------------------------------------------------------------------

export interface LinkUrlInput {
  identifier: string;
  url: string;
  title?: string;
}

export interface LinkUrlCliInput {
  issue: string;
  url: string;
  opts: { title?: string };
}

export type LinkUrlMcpInput = Record<string, unknown> & {
  identifier: string;
  url: string;
  title?: string;
};

export interface LinkUrlResult {
  identifier: string;
  attachment: LinkedUrlAttachment;
  status: LinkUrlAttachmentResult["status"];
}

const linkUrlCanonicalSchema = z
  .object({
    identifier: z.string().min(1),
    url: z.string().min(1),
    title: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Builders / execute
// ---------------------------------------------------------------------------

export function buildLinkUrlInputFromCli(input: LinkUrlCliInput): LinkUrlInput {
  return parseSurfaceInput("link.url", linkUrlCanonicalSchema, {
    identifier: input.issue,
    url: input.url,
    title: input.opts.title,
  });
}

export function buildLinkUrlInputFromMcp(input: LinkUrlMcpInput): LinkUrlInput {
  return parseSurfaceInput("link.url", linkUrlCanonicalSchema, {
    identifier: input.identifier,
    url: input.url,
    title: input.title,
  });
}

export async function executeLinkUrl(input: LinkUrlInput): Promise<LinkUrlResult> {
  const identifier = input.identifier.toUpperCase();
  const title = input.title ?? input.url;
  const result = await linkUrlAttachment(identifier, input.url, title);
  return {
    identifier,
    attachment: result.attachment,
    status: result.status,
  };
}

/** CLI JSON uses `issue` key (behavior freeze). */
export function linkUrlCliPayload(result: LinkUrlResult) {
  return {
    issue: result.identifier,
    attachment: result.attachment,
    status: result.status,
  };
}

/** MCP JSON uses `identifier` key (behavior freeze). */
export function linkUrlMcpPayload(result: LinkUrlResult) {
  return {
    identifier: result.identifier,
    attachment: result.attachment,
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// MCP schema + operation contract
// ---------------------------------------------------------------------------

const linkUrlDescription =
  "Creates a Linear Attachment whose target is a URL. Useful for linking PRs. Idempotent at the (issue, url) pair — re-calling with the same url returns the existing attachment with `status: 'already-linked'` (parity with CLI `lebop link`).";

export function buildLinkUrlMcpInputSchema(workspaceDescription: string) {
  return {
    identifier: z.string(),
    url: z.string(),
    title: z.string().optional().describe("Display title; defaults to the URL itself."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export const linkUrlOperation = {
  id: "link.url",
  domain: "link",
  resource: "attachment",
  action: "create",
  title: "Attach a URL to an issue (e.g. PR, design doc)",
  description: linkUrlDescription,
  cli: {
    command: "link",
    liveSteps: ["cli:link --json"],
  },
  mcp: {
    tool: "link_url_to_issue",
    title: "Attach a URL to an issue (e.g. PR, design doc)",
    description: linkUrlDescription,
    annotations: {
      title: "Attach a URL to an issue (e.g. PR, design doc)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["identifier", "url", "title", "workspace"],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  notes: "CLI JSON key is `issue`; MCP JSON key is `identifier` (behavior freeze).",
  fromCli: buildLinkUrlInputFromCli,
  fromMcp: buildLinkUrlInputFromMcp,
  execute: executeLinkUrl,
} satisfies SurfaceOperationContract<LinkUrlInput, LinkUrlResult, LinkUrlCliInput, LinkUrlMcpInput>;

export const LINK_SURFACE_OPERATIONS = [linkUrlOperation] as const;
