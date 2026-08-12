/**
 * Custom fields surface — list defs, get/set issue field values.
 */

import { z } from "zod";
import { parseCliLimit } from "../lib/cliOptions.ts";
import {
  getIssueCustomFields,
  listCustomFieldDefs,
  setIssueCustomField,
} from "../lib/customFields.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

// ── Custom fields ───────────────────────────────────────────────────────────

export interface CustomFieldListInput {
  teamId?: string;
  limit: number;
}

export interface CustomFieldListCliInput {
  opts: { teamId?: string; limit?: string };
}

export type CustomFieldListMcpInput = Record<string, unknown> & {
  team_id?: string;
  limit?: number;
};

export interface CustomFieldGetIssueInput {
  identifier: string;
}

export interface CustomFieldGetIssueCliInput {
  issue: string;
}

export type CustomFieldGetIssueMcpInput = Record<string, unknown> & {
  identifier: string;
};

export interface CustomFieldSetIssueInput {
  identifier: string;
  field: string;
  value: unknown;
  teamId?: string;
}

export interface CustomFieldSetIssueCliInput {
  issue: string;
  field: string;
  value: unknown;
  opts: { teamId?: string };
}

export type CustomFieldSetIssueMcpInput = Record<string, unknown> & {
  identifier: string;
  field: string;
  value: unknown;
  team_id?: string;
};

const customFieldListCanonicalSchema = z
  .object({
    teamId: z.string().optional(),
    limit: z.number().int().positive(),
  })
  .strict();

const customFieldGetIssueCanonicalSchema = z.object({ identifier: z.string() }).strict();

const customFieldSetIssueCanonicalSchema = z
  .object({
    identifier: z.string(),
    field: z.string(),
    value: z.unknown(),
    teamId: z.string().optional(),
  })
  .strict();

const customFieldsNonLiveReason =
  "Covered by scripts/live-discovery-smoke.mjs (P0/P1 coverage surfaces), not the main live step inventory.";

export function buildCustomFieldListInputFromCli(
  input: CustomFieldListCliInput,
): CustomFieldListInput {
  return parseSurfaceInput("custom_fields.list", customFieldListCanonicalSchema, {
    teamId: input.opts.teamId,
    limit: parseCliLimit(input.opts.limit, { defaultValue: 100 }),
  });
}

export function buildCustomFieldListInputFromMcp(
  input: CustomFieldListMcpInput,
): CustomFieldListInput {
  return parseSurfaceInput("custom_fields.list", customFieldListCanonicalSchema, {
    teamId: input.team_id,
    limit: input.limit ?? 100,
  });
}

export function buildCustomFieldGetIssueInputFromCli(
  input: CustomFieldGetIssueCliInput,
): CustomFieldGetIssueInput {
  return parseSurfaceInput("custom_fields.get_issue", customFieldGetIssueCanonicalSchema, {
    identifier: input.issue,
  });
}

export function buildCustomFieldGetIssueInputFromMcp(
  input: CustomFieldGetIssueMcpInput,
): CustomFieldGetIssueInput {
  return parseSurfaceInput("custom_fields.get_issue", customFieldGetIssueCanonicalSchema, {
    identifier: input.identifier,
  });
}

export function buildCustomFieldSetIssueInputFromCli(
  input: CustomFieldSetIssueCliInput,
): CustomFieldSetIssueInput {
  return parseSurfaceInput("custom_fields.set_issue", customFieldSetIssueCanonicalSchema, {
    identifier: input.issue,
    field: input.field,
    value: input.value,
    teamId: input.opts.teamId,
  });
}

export function buildCustomFieldSetIssueInputFromMcp(
  input: CustomFieldSetIssueMcpInput,
): CustomFieldSetIssueInput {
  return parseSurfaceInput("custom_fields.set_issue", customFieldSetIssueCanonicalSchema, {
    identifier: input.identifier,
    field: input.field,
    value: input.value,
    teamId: input.team_id,
  });
}

export async function executeCustomFieldList(input: CustomFieldListInput) {
  return listCustomFieldDefs({ teamId: input.teamId, limit: input.limit });
}

export async function executeCustomFieldGetIssue(input: CustomFieldGetIssueInput) {
  return getIssueCustomFields(input.identifier);
}

export async function executeCustomFieldSetIssue(input: CustomFieldSetIssueInput) {
  return setIssueCustomField({
    identifier: input.identifier,
    field: input.field,
    value: input.value,
    teamId: input.teamId,
  });
}

export const customFieldListOperation = {
  id: "custom_fields.list",
  domain: "custom_fields",
  resource: "custom_field",
  action: "list",
  title: "List custom field definitions",
  description: "List Linear custom field definitions (when the API exposes them).",
  cli: { command: "custom-field list", nonLiveReason: customFieldsNonLiveReason },
  mcp: {
    tool: "list_custom_fields",
    title: "List custom field definitions",
    description: "List Linear custom field definitions (when the API exposes them).",
    annotations: {
      title: "List custom field definitions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    // Linear schema may omit issueFields on some workspaces/API versions.
    liveSemantics: "optional",
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildCustomFieldListInputFromCli,
  fromMcp: buildCustomFieldListInputFromMcp,
  execute: executeCustomFieldList,
} satisfies SurfaceOperationContract<
  CustomFieldListInput,
  Awaited<ReturnType<typeof listCustomFieldDefs>>,
  CustomFieldListCliInput,
  CustomFieldListMcpInput
>;

export const customFieldGetIssueOperation = {
  id: "custom_fields.get_issue",
  domain: "custom_fields",
  resource: "custom_field",
  action: "get",
  title: "Get issue custom field values",
  description: "Get custom field values on an issue.",
  cli: { command: "custom-field get", nonLiveReason: customFieldsNonLiveReason },
  mcp: {
    tool: "get_issue_custom_fields",
    title: "Get issue custom field values",
    description: "Get custom field values on an issue.",
    annotations: {
      title: "Get issue custom field values",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    liveSemantics: "optional",
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildCustomFieldGetIssueInputFromCli,
  fromMcp: buildCustomFieldGetIssueInputFromMcp,
  execute: executeCustomFieldGetIssue,
} satisfies SurfaceOperationContract<
  CustomFieldGetIssueInput,
  Awaited<ReturnType<typeof getIssueCustomFields>>,
  CustomFieldGetIssueCliInput,
  CustomFieldGetIssueMcpInput
>;

export const customFieldSetIssueOperation = {
  id: "custom_fields.set_issue",
  domain: "custom_fields",
  resource: "custom_field",
  action: "update",
  title: "Set issue custom field",
  description: "Set a custom field on an issue by name or id.",
  cli: { command: "custom-field set", nonLiveReason: customFieldsNonLiveReason },
  mcp: {
    tool: "set_issue_custom_field",
    title: "Set issue custom field",
    description: "Set a custom field on an issue by name or id.",
    annotations: {
      title: "Set issue custom field",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    liveSemantics: "optional",
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildCustomFieldSetIssueInputFromCli,
  fromMcp: buildCustomFieldSetIssueInputFromMcp,
  execute: executeCustomFieldSetIssue,
} satisfies SurfaceOperationContract<
  CustomFieldSetIssueInput,
  Awaited<ReturnType<typeof setIssueCustomField>>,
  CustomFieldSetIssueCliInput,
  CustomFieldSetIssueMcpInput
>;

export function buildCustomFieldListMcpInputSchema(workspaceDescription: string) {
  return {
    team_id: z.string().optional(),
    limit: z.number().int().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCustomFieldGetIssueMcpInputSchema(workspaceDescription: string) {
  return {
    identifier: z.string(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildCustomFieldSetIssueMcpInputSchema(workspaceDescription: string) {
  return {
    identifier: z.string(),
    field: z.string(),
    value: z.unknown(),
    team_id: z.string().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}
