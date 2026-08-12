/**
 * Saved views (CustomView) surface — list/get/create/update/delete/materialize.
 */

import { z } from "zod";
import { parseCliLimit } from "../lib/cliOptions.ts";
import {
  createCustomView,
  type CustomViewListResult,
  type CustomViewSummary,
  deleteCustomView,
  getCustomView,
  listCustomViews,
  type MaterializedViewResult,
  materializeCustomView,
  updateCustomView,
} from "../lib/customViews.ts";
import { tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

// ── Views ───────────────────────────────────────────────────────────────────

export interface ViewListInput {
  limit: number;
}

export interface ViewListCliInput {
  opts: { limit?: string };
}

export type ViewListMcpInput = Record<string, unknown> & {
  limit?: number;
};

export interface ViewGetInput {
  id: string;
}

export interface ViewCreateInput {
  name: string;
  description?: string;
  teamId?: string;
  shared?: boolean;
}

export interface ViewCreateCliInput {
  opts: {
    name: string;
    description?: string;
    teamId?: string;
    shared?: boolean;
  };
}

export type ViewCreateMcpInput = Record<string, unknown> & {
  name: string;
  description?: string;
  team_id?: string;
  shared?: boolean;
};

export interface ViewUpdateInput {
  id: string;
  name?: string;
  description?: string;
  shared?: boolean;
}

export interface ViewUpdateCliInput {
  id: string;
  opts: {
    name?: string;
    description?: string;
    shared?: boolean;
  };
}

export type ViewUpdateMcpInput = Record<string, unknown> & {
  id: string;
  name?: string;
  description?: string;
  shared?: boolean;
};

export interface ViewDeleteInput {
  id: string;
}

export interface ViewDeleteCliInput {
  id: string;
  opts: { yes?: boolean };
}

export type ViewDeleteMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
};

export interface ViewMaterializeInput {
  id: string;
  limit: number;
  after?: string;
}

export interface ViewMaterializeCliInput {
  id: string;
  opts: { limit?: string; cursor?: string };
}

export type ViewMaterializeMcpInput = Record<string, unknown> & {
  id: string;
  limit?: number;
  cursor?: string;
};

const viewListCanonicalSchema = z.object({ limit: z.number().int().positive() }).strict();

const viewGetCanonicalSchema = z.object({ id: z.string() }).strict();

const viewCreateCanonicalSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    teamId: z.string().optional(),
    shared: z.boolean().optional(),
  })
  .strict();

const viewUpdateCanonicalSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    shared: z.boolean().optional(),
  })
  .strict();

const viewDeleteCanonicalSchema = z.object({ id: z.string() }).strict();

const viewMaterializeCanonicalSchema = z
  .object({
    id: z.string(),
    limit: z.number().int().positive(),
    after: z.string().optional(),
  })
  .strict();

export function buildViewListInputFromCli(input: ViewListCliInput): ViewListInput {
  return parseSurfaceInput("views.list", viewListCanonicalSchema, {
    limit: parseCliLimit(input.opts.limit, { defaultValue: 50 }),
  });
}

export function buildViewListInputFromMcp(input: ViewListMcpInput): ViewListInput {
  return parseSurfaceInput("views.list", viewListCanonicalSchema, {
    limit: input.limit ?? 50,
  });
}

export function buildViewGetInput(id: string): ViewGetInput {
  return parseSurfaceInput("views.get", viewGetCanonicalSchema, { id });
}

export function buildViewCreateInputFromCli(input: ViewCreateCliInput): ViewCreateInput {
  return parseSurfaceInput("views.create", viewCreateCanonicalSchema, {
    name: input.opts.name,
    description: input.opts.description,
    teamId: input.opts.teamId,
    shared: input.opts.shared,
  });
}

export function buildViewCreateInputFromMcp(input: ViewCreateMcpInput): ViewCreateInput {
  return parseSurfaceInput("views.create", viewCreateCanonicalSchema, {
    name: input.name,
    description: input.description,
    teamId: input.team_id,
    shared: input.shared,
  });
}

function hasViewUpdateFields(update: ViewUpdateInput): boolean {
  return (
    update.name !== undefined || update.description !== undefined || update.shared !== undefined
  );
}

export function buildViewUpdateInputFromCli(input: ViewUpdateCliInput): ViewUpdateInput {
  const update: ViewUpdateInput = { id: input.id };
  if (input.opts.name !== undefined) update.name = input.opts.name;
  if (input.opts.description !== undefined) update.description = input.opts.description;
  if (input.opts.shared !== undefined) update.shared = input.opts.shared;
  if (!hasViewUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one of --name / --description / --shared",
      "pass at least one update field",
    );
  }
  return parseSurfaceInput("views.update", viewUpdateCanonicalSchema, update);
}

export function buildViewUpdateInputFromMcp(input: ViewUpdateMcpInput): ViewUpdateInput {
  const update: ViewUpdateInput = { id: input.id };
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description;
  if (input.shared !== undefined) update.shared = input.shared;
  if (!hasViewUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass at least one of name, description, shared",
    );
  }
  return parseSurfaceInput("views.update", viewUpdateCanonicalSchema, update);
}

export function buildViewDeleteInputFromCli(input: ViewDeleteCliInput): ViewDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to delete view ${input.id} without --yes`,
      "re-run with --yes to confirm.",
    );
  }
  return parseSurfaceInput("views.delete", viewDeleteCanonicalSchema, { id: input.id });
}

export function buildViewDeleteInputFromMcp(input: ViewDeleteMcpInput): ViewDeleteInput {
  return parseSurfaceInput("views.delete", viewDeleteCanonicalSchema, { id: input.id });
}

export function buildViewMaterializeInputFromCli(
  input: ViewMaterializeCliInput,
): ViewMaterializeInput {
  return parseSurfaceInput("views.materialize", viewMaterializeCanonicalSchema, {
    id: input.id,
    limit: parseCliLimit(input.opts.limit, { defaultValue: 50 }),
    after: input.opts.cursor,
  });
}

export function buildViewMaterializeInputFromMcp(
  input: ViewMaterializeMcpInput,
): ViewMaterializeInput {
  return parseSurfaceInput("views.materialize", viewMaterializeCanonicalSchema, {
    id: input.id,
    limit: input.limit ?? 50,
    after: input.cursor,
  });
}

export async function executeViewList(input: ViewListInput): Promise<CustomViewListResult> {
  return listCustomViews({ limit: input.limit });
}

export async function executeViewGet(input: ViewGetInput): Promise<CustomViewSummary> {
  return getCustomView(input.id);
}

export async function executeViewCreate(input: ViewCreateInput): Promise<CustomViewSummary> {
  return createCustomView({
    name: input.name,
    description: input.description,
    teamId: input.teamId,
    shared: input.shared,
  });
}

export async function executeViewUpdate(input: ViewUpdateInput): Promise<CustomViewSummary> {
  return updateCustomView(input.id, {
    name: input.name,
    description: input.description,
    shared: input.shared,
  });
}

export type ViewDeleteExecutionResult = {
  id: string;
  status: "deleted" | "already-absent";
  success: boolean;
};

export async function executeViewDelete(input: ViewDeleteInput): Promise<ViewDeleteExecutionResult> {
  const r = await tryIdempotentDelete(() => deleteCustomView(input.id));
  return {
    id: input.id,
    status: r.status,
    success: r.status === "deleted" && Boolean(r.result),
  };
}

export async function executeViewMaterialize(
  input: ViewMaterializeInput,
): Promise<MaterializedViewResult> {
  return materializeCustomView({
    id: input.id,
    limit: input.limit,
    after: input.after,
  });
}

export function viewListPayload(result: CustomViewListResult) {
  return { count: result.count, views: result.views };
}

export function viewMaterializePayload(result: MaterializedViewResult) {
  return {
    view: result.view,
    count: result.count,
    has_more: result.has_more,
    next_cursor: result.next_cursor,
    issues: result.issues,
  };
}

export const viewListOperation = {
  id: "views.list",
  domain: "views",
  resource: "view",
  action: "list",
  title: "List saved views",
  description: "List Linear CustomView saved views.",
  cli: { command: "view list", liveSteps: ["cli:view list --json"] },
  mcp: {
    tool: "list_views",
    title: "List saved views",
    description: "List Linear CustomView saved views.",
    annotations: {
      title: "List saved views",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildViewListInputFromCli,
  fromMcp: buildViewListInputFromMcp,
  execute: executeViewList,
} satisfies SurfaceOperationContract<
  ViewListInput,
  CustomViewListResult,
  ViewListCliInput,
  ViewListMcpInput
>;

export const viewGetOperation = {
  id: "views.get",
  domain: "views",
  resource: "view",
  action: "get",
  title: "Get saved view",
  description: "Get one Linear CustomView by id.",
  cli: { command: "view get", liveSteps: ["cli:view get --json"] },
  mcp: {
    tool: "get_view",
    title: "Get saved view",
    description: "Get one Linear CustomView by id.",
    annotations: {
      title: "Get saved view",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  execute: executeViewGet,
} satisfies SurfaceOperationContract<ViewGetInput, CustomViewSummary>;

export const viewCreateOperation = {
  id: "views.create",
  domain: "views",
  resource: "view",
  action: "create",
  title: "Create saved view",
  description: "Create a Linear CustomView saved view.",
  cli: { command: "view create", liveSteps: ["cli:view create --json"] },
  mcp: {
    tool: "create_view",
    title: "Create saved view",
    description: "Create a Linear CustomView saved view.",
    annotations: {
      title: "Create saved view",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  fromCli: buildViewCreateInputFromCli,
  fromMcp: buildViewCreateInputFromMcp,
  execute: executeViewCreate,
} satisfies SurfaceOperationContract<
  ViewCreateInput,
  CustomViewSummary,
  ViewCreateCliInput,
  ViewCreateMcpInput
>;

export const viewUpdateOperation = {
  id: "views.update",
  domain: "views",
  resource: "view",
  action: "update",
  title: "Update saved view",
  description: "Update name/description/shared on a CustomView.",
  cli: { command: "view update", liveSteps: ["cli:view update --json"] },
  mcp: {
    tool: "update_view",
    title: "Update saved view",
    description: "Update name/description/shared on a CustomView.",
    annotations: {
      title: "Update saved view",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildViewUpdateInputFromCli,
  fromMcp: buildViewUpdateInputFromMcp,
  execute: executeViewUpdate,
} satisfies SurfaceOperationContract<
  ViewUpdateInput,
  CustomViewSummary,
  ViewUpdateCliInput,
  ViewUpdateMcpInput
>;

export const viewDeleteOperation = {
  id: "views.delete",
  domain: "views",
  resource: "view",
  action: "delete",
  title: "Delete saved view",
  description:
    "Delete a Linear CustomView by UUID. Requires confirm: true. Idempotent — re-delete returns `{status: 'already-absent'}`.",
  cli: { command: "view delete", liveSteps: ["cli:view delete --json"] },
  mcp: {
    tool: "delete_view",
    title: "Delete saved view",
    description:
      "Delete a Linear CustomView by UUID. Requires confirm: true. Idempotent — re-delete returns `{status: 'already-absent'}`.",
    annotations: {
      title: "Delete saved view",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildViewDeleteInputFromCli,
  fromMcp: buildViewDeleteInputFromMcp,
  execute: executeViewDelete,
} satisfies SurfaceOperationContract<
  ViewDeleteInput,
  ViewDeleteExecutionResult,
  ViewDeleteCliInput,
  ViewDeleteMcpInput
>;

export const viewMaterializeOperation = {
  id: "views.materialize",
  domain: "views",
  resource: "view",
  action: "list",
  title: "Materialize saved view issues",
  description: "Materialize a saved view into a dense issue list.",
  cli: { command: "view issues", liveSteps: ["cli:view issues --json"] },
  mcp: {
    tool: "materialize_view",
    title: "Materialize saved view issues",
    description: "Materialize a saved view into a dense issue list.",
    annotations: {
      title: "Materialize saved view issues",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildViewMaterializeInputFromCli,
  fromMcp: buildViewMaterializeInputFromMcp,
  execute: executeViewMaterialize,
} satisfies SurfaceOperationContract<
  ViewMaterializeInput,
  MaterializedViewResult,
  ViewMaterializeCliInput,
  ViewMaterializeMcpInput
>;

export function buildViewListMcpInputSchema(workspaceDescription: string) {
  return {
    limit: z.number().int().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildViewGetMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildViewCreateMcpInputSchema(workspaceDescription: string) {
  return {
    name: z.string(),
    description: z.string().optional(),
    team_id: z.string().optional(),
    shared: z.boolean().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildViewUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    shared: z.boolean().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildViewDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildViewMaterializeMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    limit: z.number().int().optional(),
    cursor: z.string().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}
