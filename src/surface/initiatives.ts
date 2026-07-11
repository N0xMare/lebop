import { z } from "zod";
import { parseCliLimit, parseCliNumber } from "../lib/cliOptions.ts";
import { NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import {
  archiveInitiative,
  createInitiative,
  deleteInitiative,
  type FullInitiative,
  getInitiative,
  type InitiativeRemoveProjectResult,
  initiativeAddProject,
  initiativeRemoveProject,
  type ListedInitiative,
  listInitiatives,
  resolveExistingInitiativeId,
  resolveInitiativeId,
  unarchiveInitiative,
  updateInitiative,
} from "../lib/initiatives.ts";
import { resolveProjectId } from "../lib/milestones.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

type InitiativeUpdateFields = Parameters<typeof updateInitiative>[1];

// ── Canonical inputs ────────────────────────────────────────────────────────

export interface InitiativeListInput {
  status?: string;
  ownerId?: string;
  includeArchived?: boolean;
  max: number;
}

export interface InitiativeListCliInput {
  opts: {
    status?: string;
    ownerId?: string;
    archived?: boolean;
    includeArchived?: boolean;
    limit?: string;
  };
}

export type InitiativeListMcpInput = Record<string, unknown> & {
  status?: string;
  owner_id?: string;
  include_archived?: boolean;
  limit?: number;
};

export interface InitiativeGetInput {
  /** UUID or exact initiative name (resolved via `resolveInitiativeId`). */
  id: string;
}

export interface InitiativeCreateInput {
  name: string;
  description?: string;
  status?: string;
  ownerId?: string;
  targetDate?: string;
  color?: string;
  icon?: string;
}

export interface InitiativeCreateCliInput {
  name: string;
  opts: {
    description?: string;
    status?: string;
    ownerId?: string;
    targetDate?: string;
    color?: string;
    icon?: string;
  };
}

export type InitiativeCreateMcpInput = Record<string, unknown> & {
  name: string;
  description?: string;
  status?: string;
  owner_id?: string;
  target_date?: string;
  color?: string;
  icon?: string;
};

export interface InitiativeUpdateInput {
  id: string;
  name?: string;
  description?: string;
  status?: string;
  ownerId?: string | null;
  targetDate?: string | null;
  color?: string;
  icon?: string;
}

export interface InitiativeUpdateCliInput {
  id: string;
  opts: {
    name?: string;
    description?: string;
    status?: string;
    ownerId?: string;
    clearOwner?: boolean;
    targetDate?: string;
    color?: string;
    icon?: string;
  };
}

export type InitiativeUpdateMcpInput = Record<string, unknown> & {
  id: string;
  name?: string;
  description?: string;
  status?: string;
  owner_id?: string | null;
  target_date?: string | null;
  color?: string;
  icon?: string;
};

export interface InitiativeArchiveInput {
  id: string;
}

export interface InitiativeArchiveCliInput {
  id: string;
  opts: { yes?: boolean };
}

export type InitiativeArchiveMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
};

export interface InitiativeUnarchiveInput {
  id: string;
}

export interface InitiativeDeleteInput {
  /** Original lookup token (name or UUID) for envelope `query` stability. */
  id: string;
}

export interface InitiativeDeleteCliInput {
  id: string;
  opts: { yes?: boolean };
}

export type InitiativeDeleteMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
};

export interface InitiativeAddProjectInput {
  initiative: string;
  project: string;
  sortOrder?: number;
  /**
   * How to resolve `initiative`:
   * - `"existing"` (MCP): `resolveExistingInitiativeId`
   * - `"name-or-id"` (CLI): `resolveInitiativeId`
   */
  initiativeResolve: "existing" | "name-or-id";
  initiativeNotFoundHint?: string;
  projectNotFoundHint?: string;
}

export interface InitiativeAddProjectCliInput {
  initiative: string;
  project: string;
  opts: { sortOrder?: string };
}

export type InitiativeAddProjectMcpInput = Record<string, unknown> & {
  initiative: string;
  project: string;
  sort_order?: number;
};

export interface InitiativeRemoveProjectInput {
  initiative: string;
  project: string;
  initiativeNotFoundHint?: string;
  projectNotFoundHint?: string;
}

export interface InitiativeRemoveProjectCliInput {
  initiative: string;
  project: string;
  opts: { yes?: boolean };
}

export type InitiativeRemoveProjectMcpInput = Record<string, unknown> & {
  initiative: string;
  project: string;
  confirm?: boolean;
};

// ── Results ─────────────────────────────────────────────────────────────────

export interface InitiativeListExecutionResult {
  count: number;
  initiatives: ListedInitiative[];
}

export interface InitiativeArchiveExecutionResult {
  id: string;
  success: boolean;
}

export interface InitiativeUnarchiveExecutionResult {
  id: string;
  success: boolean;
}

/**
 * Delete envelope shape shared by CLI/MCP, with channel-specific `success`:
 * - CLI: `status === "deleted" && result`
 * - MCP: `status === "deleted"` (does not gate on mutation boolean)
 */
export interface InitiativeDeleteExecutionResult {
  id: string | null;
  query: string;
  status: "deleted" | "already-absent";
  /** Mutation boolean when status is `deleted`; undefined for already-absent. */
  result?: boolean;
}

export interface InitiativeAddProjectExecutionResult {
  edge_id: string;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const initiativeListCanonicalSchema = z
  .object({
    status: z.string().optional(),
    ownerId: z.string().optional(),
    includeArchived: z.boolean().optional(),
    max: z.number(),
  })
  .strict();

const initiativeGetCanonicalSchema = z.object({ id: z.string() }).strict();

const initiativeCreateCanonicalSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    status: z.string().optional(),
    ownerId: z.string().optional(),
    targetDate: z.string().optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
  })
  .strict();

const initiativeUpdateCanonicalSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    ownerId: z.union([z.string(), z.null()]).optional(),
    targetDate: z.union([z.string(), z.null()]).optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
  })
  .strict();

const initiativeIdCanonicalSchema = z.object({ id: z.string() }).strict();

const initiativeAddProjectCanonicalSchema = z
  .object({
    initiative: z.string(),
    project: z.string(),
    sortOrder: z.number().optional(),
    initiativeResolve: z.enum(["existing", "name-or-id"]),
    initiativeNotFoundHint: z.string().optional(),
    projectNotFoundHint: z.string().optional(),
  })
  .strict();

const initiativeRemoveProjectCanonicalSchema = z
  .object({
    initiative: z.string(),
    project: z.string(),
    initiativeNotFoundHint: z.string().optional(),
    projectNotFoundHint: z.string().optional(),
  })
  .strict();

// ── Builders ────────────────────────────────────────────────────────────────

export function buildInitiativeListInputFromCli(
  input: InitiativeListCliInput,
): InitiativeListInput {
  const max = parseCliLimit(input.opts.limit, { defaultValue: 50, zeroMeansInfinity: true });
  return parseSurfaceInput("initiatives.list", initiativeListCanonicalSchema, {
    status: input.opts.status,
    ownerId: input.opts.ownerId,
    includeArchived: input.opts.includeArchived ?? input.opts.archived,
    max,
  });
}

export function buildInitiativeListInputFromMcp(
  input: InitiativeListMcpInput,
): InitiativeListInput {
  const limit = input.limit ?? 50;
  const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
  return parseSurfaceInput("initiatives.list", initiativeListCanonicalSchema, {
    status: input.status,
    ownerId: input.owner_id,
    includeArchived: input.include_archived,
    max,
  });
}

export function buildInitiativeGetInput(id: string): InitiativeGetInput {
  return parseSurfaceInput("initiatives.get", initiativeGetCanonicalSchema, { id });
}

export function buildInitiativeCreateInputFromCli(
  input: InitiativeCreateCliInput,
): InitiativeCreateInput {
  return parseSurfaceInput("initiatives.create", initiativeCreateCanonicalSchema, {
    name: input.name,
    description: input.opts.description,
    status: input.opts.status,
    ownerId: input.opts.ownerId,
    targetDate: input.opts.targetDate,
    color: input.opts.color,
    icon: input.opts.icon,
  });
}

export function buildInitiativeCreateInputFromMcp(
  input: InitiativeCreateMcpInput,
): InitiativeCreateInput {
  return parseSurfaceInput("initiatives.create", initiativeCreateCanonicalSchema, {
    name: input.name,
    description: input.description,
    status: input.status,
    ownerId: input.owner_id,
    targetDate: input.target_date,
    color: input.color,
    icon: input.icon,
  });
}

export function buildInitiativeUpdateInputFromCli(
  input: InitiativeUpdateCliInput,
): InitiativeUpdateInput {
  const update: InitiativeUpdateInput = { id: input.id };
  if (input.opts.name !== undefined) update.name = input.opts.name;
  if (input.opts.description !== undefined) update.description = input.opts.description;
  if (input.opts.status !== undefined) update.status = input.opts.status;
  if (input.opts.ownerId !== undefined && input.opts.clearOwner) {
    throw new ValidationError(
      "pass either --owner-id or --clear-owner, not both",
      "use --clear-owner to remove ownership, or --owner-id <uuid> to assign an owner",
    );
  }
  if (input.opts.clearOwner) update.ownerId = null;
  if (input.opts.ownerId !== undefined) {
    update.ownerId = input.opts.ownerId === "null" ? null : input.opts.ownerId;
  }
  if (input.opts.targetDate !== undefined) {
    update.targetDate = input.opts.targetDate === "null" ? null : input.opts.targetDate;
  }
  if (input.opts.color !== undefined) update.color = input.opts.color;
  if (input.opts.icon !== undefined) update.icon = input.opts.icon;

  if (!hasInitiativeUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass --name, --description, --status, --owner-id, --target-date, --color, or --icon",
    );
  }
  return parseSurfaceInput("initiatives.update", initiativeUpdateCanonicalSchema, update);
}

export function buildInitiativeUpdateInputFromMcp(
  input: InitiativeUpdateMcpInput,
): InitiativeUpdateInput {
  const update: InitiativeUpdateInput = { id: input.id };
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description;
  if (input.status !== undefined) update.status = input.status;
  if (input.owner_id !== undefined) update.ownerId = input.owner_id;
  if (input.target_date !== undefined) update.targetDate = input.target_date;
  if (input.color !== undefined) update.color = input.color;
  if (input.icon !== undefined) update.icon = input.icon;

  if (!hasInitiativeUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass at least one of the optional update fields",
    );
  }
  return parseSurfaceInput("initiatives.update", initiativeUpdateCanonicalSchema, update);
}

export function buildInitiativeArchiveInputFromCli(
  input: InitiativeArchiveCliInput,
): InitiativeArchiveInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      "refusing to archive initiative without --yes",
      "re-run with --yes to confirm this destructive state change",
    );
  }
  return parseSurfaceInput("initiatives.archive", initiativeIdCanonicalSchema, {
    id: input.id,
  });
}

export function buildInitiativeArchiveInputFromMcp(
  input: InitiativeArchiveMcpInput,
): InitiativeArchiveInput {
  return parseSurfaceInput("initiatives.archive", initiativeIdCanonicalSchema, {
    id: input.id,
  });
}

export function buildInitiativeUnarchiveInput(id: string): InitiativeUnarchiveInput {
  return parseSurfaceInput("initiatives.unarchive", initiativeIdCanonicalSchema, { id });
}

export function buildInitiativeDeleteInputFromCli(
  input: InitiativeDeleteCliInput,
): InitiativeDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to delete initiative ${input.id} without --yes`,
      "re-run with --yes to confirm. Use `initiative archive` for a reversible alternative.",
    );
  }
  return parseSurfaceInput("initiatives.delete", initiativeIdCanonicalSchema, {
    id: input.id,
  });
}

export function buildInitiativeDeleteInputFromMcp(
  input: InitiativeDeleteMcpInput,
): InitiativeDeleteInput {
  return parseSurfaceInput("initiatives.delete", initiativeIdCanonicalSchema, {
    id: input.id,
  });
}

export function buildInitiativeAddProjectInputFromCli(
  input: InitiativeAddProjectCliInput,
): InitiativeAddProjectInput {
  const sortOrder =
    input.opts.sortOrder !== undefined
      ? parseCliNumber(input.opts.sortOrder, {
          optionName: "--sort-order",
          allowNegative: true,
        })
      : undefined;
  return parseSurfaceInput("initiatives.add_project", initiativeAddProjectCanonicalSchema, {
    initiative: input.initiative,
    project: input.project,
    sortOrder,
    initiativeResolve: "name-or-id",
  });
}

export function buildInitiativeAddProjectInputFromMcp(
  input: InitiativeAddProjectMcpInput,
): InitiativeAddProjectInput {
  return parseSurfaceInput("initiatives.add_project", initiativeAddProjectCanonicalSchema, {
    initiative: input.initiative,
    project: input.project,
    sortOrder: input.sort_order,
    initiativeResolve: "existing",
    initiativeNotFoundHint:
      "pass the initiative name or UUID; run list_initiatives to discover ids",
    projectNotFoundHint:
      "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
  });
}

export function buildInitiativeRemoveProjectInputFromCli(
  input: InitiativeRemoveProjectCliInput,
): InitiativeRemoveProjectInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      "refusing to remove project from initiative without --yes",
      "re-run with --yes to confirm this destructive state change",
    );
  }
  return parseSurfaceInput("initiatives.remove_project", initiativeRemoveProjectCanonicalSchema, {
    initiative: input.initiative,
    project: input.project,
  });
}

export function buildInitiativeRemoveProjectInputFromMcp(
  input: InitiativeRemoveProjectMcpInput,
): InitiativeRemoveProjectInput {
  return parseSurfaceInput("initiatives.remove_project", initiativeRemoveProjectCanonicalSchema, {
    initiative: input.initiative,
    project: input.project,
    initiativeNotFoundHint:
      "pass the initiative name or UUID; run list_initiatives to discover ids",
    projectNotFoundHint:
      "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
  });
}

// ── Execute ─────────────────────────────────────────────────────────────────

export async function executeInitiativeList(
  input: InitiativeListInput,
): Promise<InitiativeListExecutionResult> {
  const initiatives = await listInitiatives({
    status: input.status,
    ownerId: input.ownerId,
    includeArchived: input.includeArchived,
    max: input.max,
  });
  return { count: initiatives.length, initiatives };
}

export function initiativeListPayload(result: InitiativeListExecutionResult) {
  return { count: result.count, initiatives: result.initiatives };
}

export async function executeInitiativeGet(
  input: InitiativeGetInput,
  notFoundHint?: string,
): Promise<FullInitiative> {
  const resolved = await resolveInitiativeId(input.id);
  if (!resolved) {
    throw new NotFoundError(`initiative not found: ${input.id}`, notFoundHint);
  }
  const initiative = await getInitiative(resolved);
  if (!initiative) {
    throw new NotFoundError(`initiative not found: ${input.id}`, notFoundHint);
  }
  return initiative;
}

export async function executeInitiativeCreate(
  input: InitiativeCreateInput,
): Promise<ListedInitiative> {
  return createInitiative({
    name: input.name,
    description: input.description,
    status: input.status,
    ownerId: input.ownerId,
    targetDate: input.targetDate,
    color: input.color,
    icon: input.icon,
  });
}

export async function executeInitiativeUpdate(
  input: InitiativeUpdateInput,
  notFoundHint?: string,
): Promise<ListedInitiative> {
  const patch: InitiativeUpdateFields = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.status !== undefined) patch.status = input.status;
  if (input.ownerId !== undefined) patch.ownerId = input.ownerId;
  if (input.targetDate !== undefined) patch.targetDate = input.targetDate;
  if (input.color !== undefined) patch.color = input.color;
  if (input.icon !== undefined) patch.icon = input.icon;

  const initiativeId = await resolveInitiativeId(input.id);
  if (!initiativeId) {
    throw new NotFoundError(`initiative not found: ${input.id}`, notFoundHint);
  }
  return updateInitiative(initiativeId, patch);
}

export async function executeInitiativeArchive(
  input: InitiativeArchiveInput,
  notFoundHint?: string,
): Promise<InitiativeArchiveExecutionResult> {
  const initiativeId = await resolveInitiativeId(input.id);
  if (!initiativeId) {
    throw new NotFoundError(`initiative not found: ${input.id}`, notFoundHint);
  }
  const success = await archiveInitiative(initiativeId);
  return { id: initiativeId, success };
}

export async function executeInitiativeUnarchive(
  input: InitiativeUnarchiveInput,
  notFoundHint?: string,
): Promise<InitiativeUnarchiveExecutionResult> {
  const initiativeId = await resolveInitiativeId(input.id);
  if (!initiativeId) {
    throw new NotFoundError(`initiative not found: ${input.id}`, notFoundHint);
  }
  const success = await unarchiveInitiative(initiativeId);
  return { id: initiativeId, success };
}

export async function executeInitiativeDelete(
  input: InitiativeDeleteInput,
): Promise<InitiativeDeleteExecutionResult> {
  // Round-9 / M-1: envelope `id` is null + `query` carries the original token
  // when name lookup fails (stable jq shape across deleted/already-absent).
  const initiativeId = await resolveInitiativeId(input.id);
  if (!initiativeId) {
    return { id: null, query: input.id, status: "already-absent" };
  }
  const result = await tryIdempotentDelete(() => deleteInitiative(initiativeId));
  return {
    id: initiativeId,
    query: input.id,
    status: result.status,
    result: result.status === "deleted" ? Boolean(result.result) : undefined,
  };
}

/** CLI success gate: deleted AND mutation returned truthy. */
export function initiativeDeleteCliSuccess(result: InitiativeDeleteExecutionResult): boolean {
  return result.status === "deleted" && Boolean(result.result);
}

/** MCP success gate: status deleted only (historical MCP envelope). */
export function initiativeDeleteMcpSuccess(result: InitiativeDeleteExecutionResult): boolean {
  return result.status === "deleted";
}

export function initiativeDeletePayload(result: InitiativeDeleteExecutionResult, success: boolean) {
  return {
    id: result.id,
    query: result.query,
    status: result.status,
    success,
  };
}

export async function executeInitiativeAddProject(
  input: InitiativeAddProjectInput,
): Promise<InitiativeAddProjectExecutionResult> {
  const initiativeId =
    input.initiativeResolve === "existing"
      ? await resolveExistingInitiativeId(input.initiative)
      : await resolveInitiativeId(input.initiative);
  if (!initiativeId) {
    throw new NotFoundError(
      `initiative not found: ${input.initiative}`,
      input.initiativeNotFoundHint,
    );
  }
  const projectId = await resolveProjectId(input.project);
  if (!projectId) {
    throw new NotFoundError(`project not found: ${input.project}`, input.projectNotFoundHint);
  }
  const edge = await initiativeAddProject({
    initiativeId,
    projectId,
    sortOrder: input.sortOrder,
  });
  return { edge_id: edge.id };
}

export async function executeInitiativeRemoveProject(
  input: InitiativeRemoveProjectInput,
): Promise<InitiativeRemoveProjectResult> {
  const initiativeId = await resolveInitiativeId(input.initiative);
  if (!initiativeId) {
    throw new NotFoundError(
      `initiative not found: ${input.initiative}`,
      input.initiativeNotFoundHint,
    );
  }
  const projectId = await resolveProjectId(input.project);
  if (!projectId) {
    throw new NotFoundError(`project not found: ${input.project}`, input.projectNotFoundHint);
  }
  return initiativeRemoveProject({ initiativeId, projectId });
}

// ── Hints / constants ───────────────────────────────────────────────────────

export const INITIATIVE_MCP_GET_HINT =
  "verify the initiative UUID/name; run list_initiatives to discover ids";

export const INITIATIVE_MCP_UPDATE_HINT =
  "pass a UUID, or a name that matches an existing initiative (case-sensitive)";

const ICON_DESCRIBE =
  "Linear internal icon name (PascalCase, e.g. 'BarChart', 'Rocket', 'Target'). Emoji are rejected locally; invalid non-emoji names may be rejected by Linear. Omit if unsure.";

// ── Operation contracts ─────────────────────────────────────────────────────

export const initiativeListOperation = {
  id: "initiatives.list",
  domain: "initiatives",
  resource: "initiative",
  action: "list",
  title: "List Linear initiatives",
  description: "Org-level planning units that group projects.",
  cli: {
    command: "initiative list",
    liveSteps: ["cli:initiative list --json"],
  },
  mcp: {
    tool: "list_initiatives",
    title: "List Linear initiatives",
    description: "Org-level planning units that group projects.",
    annotations: {
      title: "List Linear initiatives",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["status", "owner_id", "include_archived", "limit", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes: "CLI --include-archived aliases --archived; limit 0 means unbounded on both channels.",
  fromCli: buildInitiativeListInputFromCli,
  fromMcp: buildInitiativeListInputFromMcp,
} satisfies SurfaceOperationContract<
  InitiativeListInput,
  InitiativeListExecutionResult,
  InitiativeListCliInput,
  InitiativeListMcpInput
>;

export const initiativeGetOperation = {
  id: "initiatives.get",
  domain: "initiatives",
  resource: "initiative",
  action: "get",
  title: "Get one initiative (with linked projects)",
  description:
    "Returns one initiative. Missing ids/names surface as structured not_found errors, matching `lebop initiative view --json`. `id` accepts UUID or initiative name.",
  cli: {
    command: "initiative view",
    liveSteps: ["cli:initiative view --json"],
  },
  mcp: {
    tool: "get_initiative",
    title: "Get one initiative (with linked projects)",
    description:
      "Returns one initiative. Missing ids/names surface as structured not_found errors, matching `lebop initiative view --json`. `id` accepts UUID or initiative name.",
    annotations: {
      title: "Get one initiative (with linked projects)",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes: "MCP not-found hint points at list_initiatives; CLI omits hint.",
} satisfies SurfaceOperationContract<InitiativeGetInput, FullInitiative>;

export const initiativeCreateOperation = {
  id: "initiatives.create",
  domain: "initiatives",
  resource: "initiative",
  action: "create",
  title: "Create an initiative",
  description: "NOT retry-wrapped (would duplicate).",
  cli: {
    command: "initiative create",
    liveSteps: ["cli:initiative create --json"],
  },
  mcp: {
    tool: "create_initiative",
    title: "Create an initiative",
    description: "NOT retry-wrapped (would duplicate).",
    annotations: {
      title: "Create an initiative",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaKeys: [
      "name",
      "description",
      "status",
      "owner_id",
      "target_date",
      "color",
      "icon",
      "workspace",
    ],
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  fromCli: buildInitiativeCreateInputFromCli,
  fromMcp: buildInitiativeCreateInputFromMcp,
} satisfies SurfaceOperationContract<
  InitiativeCreateInput,
  ListedInitiative,
  InitiativeCreateCliInput,
  InitiativeCreateMcpInput
>;

export const initiativeUpdateOperation = {
  id: "initiatives.update",
  domain: "initiatives",
  resource: "initiative",
  action: "update",
  title: "Update an initiative",
  description:
    "Idempotent at the value level — safe to retry. The `id` field accepts a UUID OR an initiative name (resolved via `resolveInitiativeId`, matching the behavior of `get_initiative` and `archive_initiative`).",
  cli: {
    command: "initiative update",
    liveSteps: ["cli:initiative update --json"],
  },
  mcp: {
    tool: "update_initiative",
    title: "Update an initiative",
    description:
      "Idempotent at the value level — safe to retry. The `id` field accepts a UUID OR an initiative name (resolved via `resolveInitiativeId`, matching the behavior of `get_initiative` and `archive_initiative`).",
    annotations: {
      title: "Update an initiative",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: [
      "id",
      "name",
      "description",
      "status",
      "owner_id",
      "target_date",
      "color",
      "icon",
      "workspace",
    ],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  notes:
    "CLI: --clear-owner XOR --owner-id; string `null` clears owner/target-date. MCP accepts JSON null. Empty-patch messages differ by channel.",
  fromCli: buildInitiativeUpdateInputFromCli,
  fromMcp: buildInitiativeUpdateInputFromMcp,
} satisfies SurfaceOperationContract<
  InitiativeUpdateInput,
  ListedInitiative,
  InitiativeUpdateCliInput,
  InitiativeUpdateMcpInput
>;

export const initiativeArchiveOperation = {
  id: "initiatives.archive",
  domain: "initiatives",
  resource: "initiative",
  action: "update",
  title: "Archive an initiative (reversible)",
  description: "NOT retry-wrapped. `id` accepts UUID or initiative name.",
  cli: {
    command: "initiative archive",
    liveSteps: ["cli:initiative archive --json"],
  },
  mcp: {
    tool: "archive_initiative",
    title: "Archive an initiative (reversible)",
    description: "NOT retry-wrapped. `id` accepts UUID or initiative name.",
    annotations: {
      title: "Archive an initiative (reversible)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "confirm", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildInitiativeArchiveInputFromCli,
  fromMcp: buildInitiativeArchiveInputFromMcp,
} satisfies SurfaceOperationContract<
  InitiativeArchiveInput,
  InitiativeArchiveExecutionResult,
  InitiativeArchiveCliInput,
  InitiativeArchiveMcpInput
>;

export const initiativeUnarchiveOperation = {
  id: "initiatives.unarchive",
  domain: "initiatives",
  resource: "initiative",
  action: "update",
  title: "Unarchive an initiative",
  description: "NOT retry-wrapped. `id` accepts UUID or initiative name.",
  cli: {
    command: "initiative unarchive",
    liveSteps: ["cli:initiative unarchive --json"],
  },
  mcp: {
    tool: "unarchive_initiative",
    title: "Unarchive an initiative",
    description: "NOT retry-wrapped. `id` accepts UUID or initiative name.",
    annotations: {
      title: "Unarchive an initiative",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "workspace"],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
} satisfies SurfaceOperationContract<InitiativeUnarchiveInput, InitiativeUnarchiveExecutionResult>;

export const initiativeDeleteOperation = {
  id: "initiatives.delete",
  domain: "initiatives",
  resource: "initiative",
  action: "delete",
  title: "Delete an initiative permanently",
  description:
    "Delete an initiative by UUID or exact name. Soft delete server-side (sets `archived_at`); not user-restorable via Linear's standard UI flows. Idempotent — re-deleting an already-soft-deleted initiative returns `{status: 'already-absent'}`.",
  cli: {
    command: "initiative delete",
    liveSteps: ["cli:initiative delete --json"],
  },
  mcp: {
    tool: "delete_initiative",
    title: "Delete an initiative permanently",
    description:
      "Delete an initiative by UUID or exact name. Soft delete server-side (sets `archived_at`); not user-restorable via Linear's standard UI flows. Idempotent — re-deleting an already-soft-deleted initiative returns `{status: 'already-absent'}`.",
    annotations: {
      title: "Delete an initiative permanently",
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
  notes:
    "CLI success requires deleted+result truthy (sets exitCode on deleted+false). MCP success is status===deleted only. Missing lookup → id:null, query:<token>, already-absent.",
  fromCli: buildInitiativeDeleteInputFromCli,
  fromMcp: buildInitiativeDeleteInputFromMcp,
} satisfies SurfaceOperationContract<
  InitiativeDeleteInput,
  InitiativeDeleteExecutionResult,
  InitiativeDeleteCliInput,
  InitiativeDeleteMcpInput
>;

export const initiativeAddProjectOperation = {
  id: "initiatives.add_project",
  domain: "initiatives",
  resource: "initiative",
  action: "update",
  title: "Link a project to an initiative",
  description: "Server-side idempotent at the (initiative, project) tuple.",
  cli: {
    command: "initiative add-project",
    liveSteps: ["cli:initiative add-project --json"],
  },
  mcp: {
    tool: "initiative_add_project",
    title: "Link a project to an initiative",
    description: "Server-side idempotent at the (initiative, project) tuple.",
    annotations: {
      title: "Link a project to an initiative",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["initiative", "project", "sort_order", "workspace"],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  notes:
    "CLI resolves initiative via resolveInitiativeId; MCP via resolveExistingInitiativeId. MCP attaches project/initiative not-found hints.",
  fromCli: buildInitiativeAddProjectInputFromCli,
  fromMcp: buildInitiativeAddProjectInputFromMcp,
} satisfies SurfaceOperationContract<
  InitiativeAddProjectInput,
  InitiativeAddProjectExecutionResult,
  InitiativeAddProjectCliInput,
  InitiativeAddProjectMcpInput
>;

export const initiativeRemoveProjectOperation = {
  id: "initiatives.remove_project",
  domain: "initiatives",
  resource: "initiative",
  action: "update",
  title: "Unlink a project from an initiative",
  description:
    "Removes the link between a project and an initiative. " +
    "Returns { removed: boolean, reason?, message? }. " +
    "When `removed` is false, `reason` disambiguates the cause: " +
    "`absent` (no such link existed — already-removed or never-linked), " +
    "`archived` (the initiative is archived and refuses mutations — " +
    "unarchive_initiative first), or `other` (server-side rejection; " +
    "see `message`). When `removed` is true, no `reason` is set.",
  cli: {
    command: "initiative remove-project",
    liveSteps: ["cli:initiative remove-project --json"],
  },
  mcp: {
    tool: "initiative_remove_project",
    title: "Unlink a project from an initiative",
    description:
      "Removes the link between a project and an initiative. " +
      "Returns { removed: boolean, reason?, message? }. " +
      "When `removed` is false, `reason` disambiguates the cause: " +
      "`absent` (no such link existed — already-removed or never-linked), " +
      "`archived` (the initiative is archived and refuses mutations — " +
      "unarchive_initiative first), or `other` (server-side rejection; " +
      "see `message`). When `removed` is true, no `reason` is set.",
    annotations: {
      title: "Unlink a project from an initiative",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaKeys: ["initiative", "project", "confirm", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildInitiativeRemoveProjectInputFromCli,
  fromMcp: buildInitiativeRemoveProjectInputFromMcp,
} satisfies SurfaceOperationContract<
  InitiativeRemoveProjectInput,
  InitiativeRemoveProjectResult,
  InitiativeRemoveProjectCliInput,
  InitiativeRemoveProjectMcpInput
>;

export const INITIATIVE_SURFACE_OPERATIONS = [
  initiativeListOperation,
  initiativeGetOperation,
  initiativeCreateOperation,
  initiativeUpdateOperation,
  initiativeArchiveOperation,
  initiativeUnarchiveOperation,
  initiativeDeleteOperation,
  initiativeAddProjectOperation,
  initiativeRemoveProjectOperation,
] as const;

// ── MCP input schemas ───────────────────────────────────────────────────────

export function buildInitiativeListMcpInputSchema(workspaceDescription: string) {
  return {
    status: z.string().optional(),
    owner_id: z.string().optional(),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(0).optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeGetMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeCreateMcpInputSchema(workspaceDescription: string) {
  return {
    name: z.string(),
    description: z.string().optional(),
    status: z.string().optional(),
    owner_id: z.string().optional(),
    target_date: z.string().optional(),
    color: z.string().optional(),
    icon: z.string().optional().describe(ICON_DESCRIBE),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Initiative UUID OR name (resolved server-side)."),
    name: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    owner_id: z.union([z.string(), z.null()]).optional(),
    target_date: z.union([z.string(), z.null()]).optional(),
    color: z.string().optional(),
    icon: z.string().optional().describe(ICON_DESCRIBE),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeArchiveMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
    confirm: z.boolean().optional().describe("Required true for destructive execution."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeUnarchiveMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeAddProjectMcpInputSchema(workspaceDescription: string) {
  return {
    initiative: z.string().describe("Initiative name or UUID."),
    project: z.string().describe("Project name or UUID."),
    sort_order: z.number().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeRemoveProjectMcpInputSchema(workspaceDescription: string) {
  return {
    initiative: z.string(),
    project: z.string(),
    confirm: z.boolean().optional().describe("Required true for destructive execution."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

// ── Internals ───────────────────────────────────────────────────────────────

function hasInitiativeUpdateFields(input: InitiativeUpdateInput): boolean {
  return (
    input.name !== undefined ||
    input.description !== undefined ||
    input.status !== undefined ||
    input.ownerId !== undefined ||
    input.targetDate !== undefined ||
    input.color !== undefined ||
    input.icon !== undefined
  );
}
