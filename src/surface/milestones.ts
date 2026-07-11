import { z } from "zod";
import { parseCliNumber } from "../lib/cliOptions.ts";
import { NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  type ListedMilestone,
  listMilestones,
  resolveExistingProjectId,
  resolveProjectId,
  updateMilestone,
} from "../lib/milestones.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

type MilestoneUpdateFields = Parameters<typeof updateMilestone>[1];

// ── Canonical inputs ────────────────────────────────────────────────────────

export interface MilestoneListInput {
  project?: string;
  includeArchived?: boolean;
}

export interface MilestoneListCliInput {
  opts: {
    project?: string;
    includeArchived?: boolean;
  };
}

export type MilestoneListMcpInput = Record<string, unknown> & {
  project?: string;
  include_archived?: boolean;
};

export interface MilestoneGetInput {
  id: string;
}

export interface MilestoneCreateInput {
  name: string;
  /** Name-or-UUID selector (CLI `--project` / MCP `project`). */
  project?: string;
  /** CLI `--project-id` only — UUID passthrough, no name lookup. */
  projectId?: string;
  /**
   * How to resolve `project` when set:
   * - `"existing"` (MCP): `resolveExistingProjectId` (UUID must exist)
   * - `"name-or-id"` (CLI): `resolveProjectId` (UUID passthrough)
   */
  projectResolve: "existing" | "name-or-id";
  description?: string;
  targetDate?: string;
  sortOrder?: number;
  /** Channel-specific NotFoundError hint when project selector misses. */
  projectNotFoundHint?: string;
}

export interface MilestoneCreateCliInput {
  name: string;
  opts: {
    project?: string;
    projectId?: string;
    description?: string;
    targetDate?: string;
    sortOrder?: string;
  };
}

export type MilestoneCreateMcpInput = Record<string, unknown> & {
  name: string;
  project: string;
  description?: string;
  target_date?: string;
  sort_order?: number;
};

export interface MilestoneUpdateInput {
  id: string;
  name?: string;
  description?: string;
  targetDate?: string | null;
  sortOrder?: number;
  project?: string;
}

export interface MilestoneUpdateCliInput {
  id: string;
  opts: {
    name?: string;
    description?: string;
    targetDate?: string;
    sortOrder?: string;
    project?: string;
  };
}

export type MilestoneUpdateMcpInput = Record<string, unknown> & {
  id: string;
  name?: string;
  description?: string;
  target_date?: string | null;
  sort_order?: number;
  project?: string;
};

export interface MilestoneDeleteInput {
  id: string;
}

export interface MilestoneDeleteCliInput {
  id: string;
  opts: {
    yes?: boolean;
  };
}

export type MilestoneDeleteMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
};

// ── Results ─────────────────────────────────────────────────────────────────

export interface MilestoneListExecutionResult {
  count: number;
  milestones: ListedMilestone[];
}

export interface MilestoneDeleteExecutionResult {
  id: string;
  status: "deleted" | "already-absent";
  success: boolean;
}

export interface MilestoneProjectNotFoundHints {
  projectNotFoundHint?: string;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const milestoneListCanonicalSchema = z
  .object({
    project: z.string().optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();

const milestoneGetCanonicalSchema = z.object({ id: z.string() }).strict();

const milestoneCreateCanonicalSchema = z
  .object({
    name: z.string(),
    project: z.string().optional(),
    projectId: z.string().optional(),
    projectResolve: z.enum(["existing", "name-or-id"]),
    description: z.string().optional(),
    targetDate: z.string().optional(),
    sortOrder: z.number().optional(),
    projectNotFoundHint: z.string().optional(),
  })
  .strict();

const milestoneUpdateCanonicalSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    targetDate: z.union([z.string(), z.null()]).optional(),
    sortOrder: z.number().optional(),
    project: z.string().optional(),
  })
  .strict();

const milestoneDeleteCanonicalSchema = z.object({ id: z.string() }).strict();

// ── Builders ────────────────────────────────────────────────────────────────

export function buildMilestoneListInputFromCli(input: MilestoneListCliInput): MilestoneListInput {
  return parseSurfaceInput("milestones.list", milestoneListCanonicalSchema, {
    project: input.opts.project,
    includeArchived: input.opts.includeArchived,
  });
}

export function buildMilestoneListInputFromMcp(input: MilestoneListMcpInput): MilestoneListInput {
  return parseSurfaceInput("milestones.list", milestoneListCanonicalSchema, {
    project: input.project,
    includeArchived: input.include_archived,
  });
}

export function buildMilestoneGetInput(id: string): MilestoneGetInput {
  return parseSurfaceInput("milestones.get", milestoneGetCanonicalSchema, { id });
}

export function buildMilestoneCreateInputFromCli(
  input: MilestoneCreateCliInput,
): MilestoneCreateInput {
  if (input.opts.project && input.opts.projectId) {
    throw new ValidationError(
      "pass exactly one of --project / --project-id, not both",
      "choose one project selector",
    );
  }
  if (!input.opts.project && !input.opts.projectId) {
    throw new ValidationError(
      "either --project <name-or-id> or --project-id <uuid> is required",
      "milestones must be created inside a project",
    );
  }
  const sortOrder =
    input.opts.sortOrder !== undefined
      ? parseCliNumber(input.opts.sortOrder, {
          optionName: "--sort-order",
          allowNegative: true,
        })
      : undefined;
  return parseSurfaceInput("milestones.create", milestoneCreateCanonicalSchema, {
    name: input.name,
    project: input.opts.project,
    projectId: input.opts.projectId,
    projectResolve: "name-or-id",
    description: input.opts.description,
    targetDate: input.opts.targetDate,
    sortOrder,
  });
}

export function buildMilestoneCreateInputFromMcp(
  input: MilestoneCreateMcpInput,
): MilestoneCreateInput {
  return parseSurfaceInput("milestones.create", milestoneCreateCanonicalSchema, {
    name: input.name,
    project: input.project,
    projectResolve: "existing",
    description: input.description,
    targetDate: input.target_date,
    sortOrder: input.sort_order,
    projectNotFoundHint:
      "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
  });
}

export function buildMilestoneUpdateInputFromCli(
  input: MilestoneUpdateCliInput,
): MilestoneUpdateInput {
  const update: MilestoneUpdateInput = { id: input.id };
  if (input.opts.name !== undefined) update.name = input.opts.name;
  if (input.opts.description !== undefined) update.description = input.opts.description;
  if (input.opts.targetDate !== undefined) {
    update.targetDate = input.opts.targetDate === "null" ? null : input.opts.targetDate;
  }
  if (input.opts.sortOrder !== undefined) {
    update.sortOrder = parseCliNumber(input.opts.sortOrder, {
      optionName: "--sort-order",
      allowNegative: true,
    });
  }
  if (input.opts.project !== undefined) update.project = input.opts.project;

  if (!hasMilestoneUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one of --name / --description / --target-date / --sort-order / --project",
      "pass at least one update field",
    );
  }
  return parseSurfaceInput("milestones.update", milestoneUpdateCanonicalSchema, update);
}

export function buildMilestoneUpdateInputFromMcp(
  input: MilestoneUpdateMcpInput,
): MilestoneUpdateInput {
  const update: MilestoneUpdateInput = { id: input.id };
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description;
  if (input.target_date !== undefined) update.targetDate = input.target_date;
  if (input.sort_order !== undefined) update.sortOrder = input.sort_order;
  if (input.project !== undefined) update.project = input.project;

  if (!hasMilestoneUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass at least one of the optional update fields",
    );
  }
  return parseSurfaceInput("milestones.update", milestoneUpdateCanonicalSchema, update);
}

export function buildMilestoneDeleteInputFromCli(
  input: MilestoneDeleteCliInput,
): MilestoneDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to delete milestone ${input.id} without --yes`,
      "re-run with --yes to confirm. This operation is irreversible.",
    );
  }
  return parseSurfaceInput("milestones.delete", milestoneDeleteCanonicalSchema, {
    id: input.id,
  });
}

export function buildMilestoneDeleteInputFromMcp(
  input: MilestoneDeleteMcpInput,
): MilestoneDeleteInput {
  return parseSurfaceInput("milestones.delete", milestoneDeleteCanonicalSchema, {
    id: input.id,
  });
}

// ── Execute ─────────────────────────────────────────────────────────────────

export async function executeMilestoneList(
  input: MilestoneListInput,
  channel: MilestoneProjectNotFoundHints = {},
): Promise<MilestoneListExecutionResult> {
  let projectId: string | undefined;
  if (input.project) {
    const resolved = await resolveExistingProjectId(input.project);
    if (!resolved) {
      throw new NotFoundError(`project not found: ${input.project}`, channel.projectNotFoundHint);
    }
    projectId = resolved;
  }
  const milestones = await listMilestones({
    projectId,
    includeArchived: Boolean(input.includeArchived),
  });
  return { count: milestones.length, milestones };
}

export function milestoneListPayload(result: MilestoneListExecutionResult) {
  return { count: result.count, milestones: result.milestones };
}

export async function executeMilestoneGet(
  input: MilestoneGetInput,
  hint?: string,
): Promise<ListedMilestone> {
  const milestone = await getMilestone(input.id);
  if (!milestone) {
    throw new NotFoundError(`milestone not found: ${input.id}`, hint);
  }
  return milestone;
}

export async function executeMilestoneCreate(
  input: MilestoneCreateInput,
): Promise<ListedMilestone> {
  const projectId = await resolveCreateProjectId(input);
  return createMilestone({
    name: input.name,
    projectId,
    description: input.description,
    targetDate: input.targetDate,
    sortOrder: input.sortOrder,
  });
}

export async function executeMilestoneUpdate(
  input: MilestoneUpdateInput,
  channel: MilestoneProjectNotFoundHints = {},
): Promise<ListedMilestone> {
  const patch: MilestoneUpdateFields = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.targetDate !== undefined) patch.targetDate = input.targetDate;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (input.project !== undefined) {
    const projectId = await resolveProjectId(input.project);
    if (!projectId) {
      throw new NotFoundError(`project not found: ${input.project}`, channel.projectNotFoundHint);
    }
    patch.projectId = projectId;
  }
  return updateMilestone(input.id, patch);
}

export async function executeMilestoneDelete(
  input: MilestoneDeleteInput,
): Promise<MilestoneDeleteExecutionResult> {
  const result = await tryIdempotentDelete(() => deleteMilestone(input.id));
  return {
    id: input.id,
    status: result.status,
    success: result.status === "deleted" && Boolean(result.result),
  };
}

// ── Operation contracts ─────────────────────────────────────────────────────

const MCP_PROJECT_NOT_FOUND_HINT =
  "pass the project name (case-sensitive) or UUID; run list_projects to discover ids";

const MCP_GET_HINT = "verify the milestone UUID; run list_milestones to discover ids";

export const milestoneListOperation = {
  id: "milestones.list",
  domain: "milestones",
  resource: "milestone",
  action: "list",
  title: "List project milestones",
  description:
    "List milestones; pass project to filter to one project (name or UUID). Each milestone includes `archived_at` (string | null). Defaults to live milestones only — pass `include_archived: true` to also surface cascade-archived rows (parent-project archived).",
  cli: {
    command: "milestone list",
    liveSteps: ["cli:milestone list --json"],
  },
  mcp: {
    tool: "list_milestones",
    title: "List project milestones",
    description:
      "List milestones; pass project to filter to one project (name or UUID). Each milestone includes `archived_at` (string | null). Defaults to live milestones only — pass `include_archived: true` to also surface cascade-archived rows (parent-project archived).",
    annotations: {
      title: "List project milestones",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["project", "include_archived", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildMilestoneListInputFromCli,
  fromMcp: buildMilestoneListInputFromMcp,
} satisfies SurfaceOperationContract<
  MilestoneListInput,
  MilestoneListExecutionResult,
  MilestoneListCliInput,
  MilestoneListMcpInput
>;

export const milestoneGetOperation = {
  id: "milestones.get",
  domain: "milestones",
  resource: "milestone",
  action: "get",
  title: "Get one milestone by UUID",
  description:
    "Returns one milestone. Missing ids surface as structured not_found errors, matching `lebop milestone view --json`. Cascade-archived milestones (parent-project archived) are surfaced — distinguish via `archived_at`. Uses an archive-resilient list-shape query (the single-record `projectMilestone(id:)` getter silently drops cascade-archived rows; see docs/spec.md §12.1).",
  cli: { command: "milestone view", liveSteps: ["cli:milestone view --json"] },
  mcp: {
    tool: "get_milestone",
    title: "Get one milestone by UUID",
    description:
      "Returns one milestone. Missing ids surface as structured not_found errors, matching `lebop milestone view --json`. Cascade-archived milestones (parent-project archived) are surfaced — distinguish via `archived_at`. Uses an archive-resilient list-shape query (the single-record `projectMilestone(id:)` getter silently drops cascade-archived rows; see docs/spec.md §12.1).",
    annotations: {
      title: "Get one milestone by UUID",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
} satisfies SurfaceOperationContract<MilestoneGetInput, ListedMilestone>;

export const milestoneCreateOperation = {
  id: "milestones.create",
  domain: "milestones",
  resource: "milestone",
  action: "create",
  title: "Create a project milestone",
  description: "Create within a project (name or UUID). NOT retry-wrapped.",
  cli: { command: "milestone create", liveSteps: ["cli:milestone create --json"] },
  mcp: {
    tool: "create_milestone",
    title: "Create a project milestone",
    description: "Create within a project (name or UUID). NOT retry-wrapped.",
    annotations: {
      title: "Create a project milestone",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaKeys: ["name", "project", "description", "target_date", "sort_order", "workspace"],
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  notes:
    "CLI accepts --project (name-or-id via resolveProjectId) or --project-id (UUID passthrough), mutually exclusive. MCP accepts project only via resolveExistingProjectId.",
  fromCli: buildMilestoneCreateInputFromCli,
  fromMcp: buildMilestoneCreateInputFromMcp,
} satisfies SurfaceOperationContract<
  MilestoneCreateInput,
  ListedMilestone,
  MilestoneCreateCliInput,
  MilestoneCreateMcpInput
>;

export const milestoneUpdateOperation = {
  id: "milestones.update",
  domain: "milestones",
  resource: "milestone",
  action: "update",
  title: "Update a milestone",
  description: "Idempotent at the value level — safe to retry.",
  cli: { command: "milestone update", liveSteps: ["cli:milestone update --json"] },
  mcp: {
    tool: "update_milestone",
    title: "Update a milestone",
    description: "Idempotent at the value level — safe to retry.",
    annotations: {
      title: "Update a milestone",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: [
      "id",
      "name",
      "description",
      "target_date",
      "sort_order",
      "project",
      "workspace",
    ],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  notes:
    "CLI clears target-date with the string `null`; MCP accepts JSON null. Empty-patch validation messages differ by channel (preserved in fromCli/fromMcp).",
  fromCli: buildMilestoneUpdateInputFromCli,
  fromMcp: buildMilestoneUpdateInputFromMcp,
} satisfies SurfaceOperationContract<
  MilestoneUpdateInput,
  ListedMilestone,
  MilestoneUpdateCliInput,
  MilestoneUpdateMcpInput
>;

export const milestoneDeleteOperation = {
  id: "milestones.delete",
  domain: "milestones",
  resource: "milestone",
  action: "delete",
  title: "Delete a milestone",
  description:
    "Delete a milestone by UUID. Idempotent — re-deleting an already-absent milestone returns `{status: 'already-absent'}`.",
  cli: { command: "milestone delete", liveSteps: ["cli:milestone delete --json"] },
  mcp: {
    tool: "delete_milestone",
    title: "Delete a milestone",
    description:
      "Delete a milestone by UUID. Idempotent — re-deleting an already-absent milestone returns `{status: 'already-absent'}`.",
    annotations: {
      title: "Delete a milestone",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "confirm", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildMilestoneDeleteInputFromCli,
  fromMcp: buildMilestoneDeleteInputFromMcp,
} satisfies SurfaceOperationContract<
  MilestoneDeleteInput,
  MilestoneDeleteExecutionResult,
  MilestoneDeleteCliInput,
  MilestoneDeleteMcpInput
>;

export const MILESTONE_SURFACE_OPERATIONS = [
  milestoneListOperation,
  milestoneGetOperation,
  milestoneCreateOperation,
  milestoneUpdateOperation,
  milestoneDeleteOperation,
] as const;

// ── MCP input schemas ───────────────────────────────────────────────────────

export function buildMilestoneListMcpInputSchema(workspaceDescription: string) {
  return {
    project: z.string().optional().describe("Project name or UUID."),
    include_archived: z
      .boolean()
      .optional()
      .describe("Include cascade-archived milestones in the result. Defaults to false."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildMilestoneGetMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildMilestoneCreateMcpInputSchema(workspaceDescription: string) {
  return {
    name: z.string(),
    project: z.string().describe("Project name or UUID."),
    description: z.string().optional(),
    target_date: z.string().optional().describe("ISO date, e.g. 2026-12-31."),
    sort_order: z.number().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildMilestoneUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    target_date: z.union([z.string(), z.null()]).optional().describe("ISO date or null to clear."),
    sort_order: z.number().optional(),
    project: z.string().optional().describe("Move to a different project (name or UUID)."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildMilestoneDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

/** MCP channel defaults for project-not-found hints. */
export const MILESTONE_MCP_PROJECT_NOT_FOUND_HINT = MCP_PROJECT_NOT_FOUND_HINT;
export const MILESTONE_MCP_GET_HINT = MCP_GET_HINT;

// ── Internals ───────────────────────────────────────────────────────────────

function hasMilestoneUpdateFields(input: MilestoneUpdateInput): boolean {
  return (
    input.name !== undefined ||
    input.description !== undefined ||
    input.targetDate !== undefined ||
    input.sortOrder !== undefined ||
    input.project !== undefined
  );
}

async function resolveCreateProjectId(input: MilestoneCreateInput): Promise<string> {
  if (input.projectId) {
    return input.projectId;
  }
  if (!input.project) {
    throw new ValidationError(
      "either --project <name-or-id> or --project-id <uuid> is required",
      "milestones must be created inside a project",
    );
  }
  const projectId =
    input.projectResolve === "existing"
      ? await resolveExistingProjectId(input.project)
      : await resolveProjectId(input.project);
  if (!projectId) {
    throw new NotFoundError(`project not found: ${input.project}`, input.projectNotFoundHint);
  }
  return projectId;
}
