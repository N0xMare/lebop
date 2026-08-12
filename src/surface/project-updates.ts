import { z } from "zod";
import { NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import { resolveExistingProjectId, resolveProjectId } from "../lib/milestones.ts";
import {
  assertProjectUpdateBody,
  createProjectUpdate,
  deleteProjectUpdateEntry,
  type ListedProjectUpdate,
  listProjectUpdates,
  type ProjectHealth,
  updateProjectUpdateEntry,
} from "../lib/projects.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

export const PROJECT_UPDATE_HEALTH_VALUES = ["onTrack", "atRisk", "offTrack"] as const;

// ── Canonical inputs ────────────────────────────────────────────────────────

export interface ProjectUpdateListInput {
  project: string;
  /**
   * How to resolve `project`:
   * - `"existing"` (CLI list): `resolveExistingProjectId`
   * - `"name-or-id"` (MCP list / both create paths): `resolveProjectId`
   */
  projectResolve: "existing" | "name-or-id";
  projectNotFoundHint?: string;
}

export interface ProjectUpdateListCliInput {
  project: string;
}

export type ProjectUpdateListMcpInput = Record<string, unknown> & {
  project: string;
};

export interface ProjectUpdateCreateInput {
  project: string;
  body: string;
  health?: ProjectHealth;
  projectNotFoundHint?: string;
}

export interface ProjectUpdateCreateCliInput {
  project: string;
  body: string;
  health?: string;
}

export type ProjectUpdateCreateMcpInput = Record<string, unknown> & {
  project: string;
  body: string;
  health?: ProjectHealth;
};

export interface ProjectUpdateUpdateInput {
  id: string;
  body?: string;
  health?: ProjectHealth;
}

export interface ProjectUpdateUpdateCliInput {
  id: string;
  body?: string;
  health?: string;
}

export type ProjectUpdateUpdateMcpInput = Record<string, unknown> & {
  id: string;
  body?: string;
  health?: ProjectHealth;
};

export interface ProjectUpdateDeleteInput {
  id: string;
}

export interface ProjectUpdateDeleteCliInput {
  id: string;
  opts: { yes?: boolean };
}

export type ProjectUpdateDeleteMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
};

// ── Results ─────────────────────────────────────────────────────────────────

export interface ProjectUpdateListExecutionResult {
  project_id: string;
  count: number;
  updates: ListedProjectUpdate[];
}

export interface ProjectUpdateCreateExecutionResult {
  project_id: string;
  project_update: ListedProjectUpdate;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const projectUpdateListCanonicalSchema = z
  .object({
    project: z.string().min(1),
    projectResolve: z.enum(["existing", "name-or-id"]),
    projectNotFoundHint: z.string().optional(),
  })
  .strict();

const projectUpdateCreateCanonicalSchema = z
  .object({
    project: z.string().min(1),
    body: z.string(),
    health: z.enum(PROJECT_UPDATE_HEALTH_VALUES).optional(),
    projectNotFoundHint: z.string().optional(),
  })
  .strict();

const projectUpdateUpdateCanonicalSchema = z
  .object({
    id: z.string().min(1),
    body: z.string().optional(),
    health: z.enum(PROJECT_UPDATE_HEALTH_VALUES).optional(),
  })
  .strict();

const projectUpdateDeleteCanonicalSchema = z.object({ id: z.string().min(1) }).strict();

// ── Builders ────────────────────────────────────────────────────────────────

export function buildProjectUpdateListInputFromCli(
  input: ProjectUpdateListCliInput,
): ProjectUpdateListInput {
  return parseSurfaceInput("project_updates.list", projectUpdateListCanonicalSchema, {
    project: input.project,
    projectResolve: "existing",
  });
}

export function buildProjectUpdateListInputFromMcp(
  input: ProjectUpdateListMcpInput,
): ProjectUpdateListInput {
  return parseSurfaceInput("project_updates.list", projectUpdateListCanonicalSchema, {
    project: input.project,
    projectResolve: "name-or-id",
    projectNotFoundHint: PROJECT_UPDATE_MCP_PROJECT_NOT_FOUND_HINT,
  });
}

export function buildProjectUpdateCreateInputFromCli(
  input: ProjectUpdateCreateCliInput,
): ProjectUpdateCreateInput {
  if (!input.body.trim()) {
    throw new ValidationError("empty update body", "pass --body, --body-file, or --stdin");
  }
  let health: ProjectHealth | undefined;
  if (input.health) {
    if (!(PROJECT_UPDATE_HEALTH_VALUES as readonly string[]).includes(input.health)) {
      throw new ValidationError(
        `invalid --health "${input.health}". expected: ${PROJECT_UPDATE_HEALTH_VALUES.join(", ")}`,
        `expected one of: ${PROJECT_UPDATE_HEALTH_VALUES.join(", ")}`,
      );
    }
    health = input.health as ProjectHealth;
  }
  return parseSurfaceInput("project_updates.create", projectUpdateCreateCanonicalSchema, {
    project: input.project,
    body: input.body,
    health,
  });
}

export function buildProjectUpdateCreateInputFromMcp(
  input: ProjectUpdateCreateMcpInput,
): ProjectUpdateCreateInput {
  // Preserve pre-migration MCP order: assert body before project resolve.
  assertProjectUpdateBody(input.body);
  return parseSurfaceInput("project_updates.create", projectUpdateCreateCanonicalSchema, {
    project: input.project,
    body: input.body,
    health: input.health,
    projectNotFoundHint: PROJECT_UPDATE_MCP_PROJECT_NOT_FOUND_HINT,
  });
}

function parseOptionalHealth(
  health: string | undefined,
  channel: "cli" | "mcp",
): ProjectHealth | undefined {
  if (health === undefined) return undefined;
  if (!(PROJECT_UPDATE_HEALTH_VALUES as readonly string[]).includes(health)) {
    throw new ValidationError(
      channel === "cli"
        ? `invalid --health "${health}". expected: ${PROJECT_UPDATE_HEALTH_VALUES.join(", ")}`
        : `invalid health "${health}"`,
      `expected one of: ${PROJECT_UPDATE_HEALTH_VALUES.join(", ")}`,
    );
  }
  return health as ProjectHealth;
}

function hasProjectUpdateUpdateFields(update: ProjectUpdateUpdateInput): boolean {
  return update.body !== undefined || update.health !== undefined;
}

export function buildProjectUpdateUpdateInputFromCli(
  input: ProjectUpdateUpdateCliInput,
): ProjectUpdateUpdateInput {
  const update: ProjectUpdateUpdateInput = {
    id: input.id,
    health: parseOptionalHealth(input.health, "cli"),
  };
  if (input.body !== undefined) {
    if (!input.body.trim()) {
      throw new ValidationError("empty update body", "pass --body, --body-file, or --stdin");
    }
    update.body = input.body;
  }
  if (!hasProjectUpdateUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one of --body / --health",
      "pass at least one update field",
    );
  }
  return parseSurfaceInput("project_updates.update", projectUpdateUpdateCanonicalSchema, update);
}

export function buildProjectUpdateUpdateInputFromMcp(
  input: ProjectUpdateUpdateMcpInput,
): ProjectUpdateUpdateInput {
  const update: ProjectUpdateUpdateInput = { id: input.id };
  if (input.body !== undefined) {
    assertProjectUpdateBody(input.body);
    update.body = input.body;
  }
  if (input.health !== undefined) update.health = input.health;
  if (!hasProjectUpdateUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass at least one of body, health",
    );
  }
  return parseSurfaceInput("project_updates.update", projectUpdateUpdateCanonicalSchema, update);
}

export function buildProjectUpdateDeleteInputFromCli(
  input: ProjectUpdateDeleteCliInput,
): ProjectUpdateDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to delete project update ${input.id} without --yes`,
      "re-run with --yes to confirm.",
    );
  }
  return parseSurfaceInput("project_updates.soft_delete", projectUpdateDeleteCanonicalSchema, {
    id: input.id,
  });
}

export function buildProjectUpdateDeleteInputFromMcp(
  input: ProjectUpdateDeleteMcpInput,
): ProjectUpdateDeleteInput {
  return parseSurfaceInput("project_updates.soft_delete", projectUpdateDeleteCanonicalSchema, {
    id: input.id,
  });
}

// ── Execute ─────────────────────────────────────────────────────────────────

export async function executeProjectUpdateList(
  input: ProjectUpdateListInput,
): Promise<ProjectUpdateListExecutionResult> {
  const projectId =
    input.projectResolve === "existing"
      ? await resolveExistingProjectId(input.project)
      : await resolveProjectId(input.project);
  if (!projectId) {
    throw new NotFoundError(`project not found: ${input.project}`, input.projectNotFoundHint);
  }
  const updates = await listProjectUpdates(projectId);
  return {
    project_id: projectId,
    count: updates.length,
    updates,
  };
}

export function projectUpdateListPayload(result: ProjectUpdateListExecutionResult) {
  return {
    project_id: result.project_id,
    count: result.count,
    updates: result.updates,
  };
}

export async function executeProjectUpdateCreate(
  input: ProjectUpdateCreateInput,
): Promise<ProjectUpdateCreateExecutionResult> {
  const projectId = await resolveProjectId(input.project);
  if (!projectId) {
    throw new NotFoundError(`project not found: ${input.project}`, input.projectNotFoundHint);
  }
  const project_update = await createProjectUpdate({
    projectId,
    body: input.body,
    health: input.health,
  });
  return { project_id: projectId, project_update };
}

export async function executeProjectUpdateUpdate(
  input: ProjectUpdateUpdateInput,
): Promise<ListedProjectUpdate> {
  return updateProjectUpdateEntry(input.id, {
    body: input.body,
    health: input.health,
  });
}

export type ProjectUpdateDeleteExecutionResult = {
  id: string;
  status: "deleted" | "already-absent";
  success: boolean;
  archived: boolean;
};

export async function executeProjectUpdateDelete(
  input: ProjectUpdateDeleteInput,
): Promise<ProjectUpdateDeleteExecutionResult> {
  const r = await tryIdempotentDelete(() => deleteProjectUpdateEntry(input.id));
  return {
    id: input.id,
    status: r.status,
    success: r.status === "deleted" && Boolean(r.result),
    archived: r.status === "deleted",
  };
}

// ── Operation contracts ─────────────────────────────────────────────────────

const PROJECT_UPDATE_MCP_PROJECT_NOT_FOUND_HINT =
  "pass the project name (case-sensitive) or UUID; run list_projects to discover ids";

export const projectUpdateListOperation = {
  id: "project_updates.list",
  domain: "projects",
  resource: "project_update",
  action: "list",
  title: "List project status updates",
  description: "Chronological status posts for one project.",
  cli: {
    command: "project-update list",
    liveSteps: ["cli:project-update list --json"],
  },
  mcp: {
    tool: "list_project_updates",
    title: "List project status updates",
    description: "Chronological status posts for one project.",
    annotations: {
      title: "List project status updates",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes:
    "CLI list resolves via resolveExistingProjectId (no not-found hint). MCP list resolves via resolveProjectId with list_projects discovery hint.",
  fromCli: buildProjectUpdateListInputFromCli,
  fromMcp: buildProjectUpdateListInputFromMcp,
  execute: executeProjectUpdateList,
} satisfies SurfaceOperationContract<
  ProjectUpdateListInput,
  ProjectUpdateListExecutionResult,
  ProjectUpdateListCliInput,
  ProjectUpdateListMcpInput
>;

export const projectUpdateCreateOperation = {
  id: "project_updates.create",
  domain: "projects",
  resource: "project_update",
  action: "create",
  title: "Post a project status update",
  description: "Optionally tagged with health (onTrack | atRisk | offTrack). NOT retry-wrapped.",
  cli: {
    command: "project-update create",
    liveSteps: ["cli:project-update create --json"],
  },
  mcp: {
    tool: "create_project_update",
    title: "Post a project status update",
    description: "Optionally tagged with health (onTrack | atRisk | offTrack). NOT retry-wrapped.",
    annotations: {
      title: "Post a project status update",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  notes:
    "CLI empty-body message is channel-specific (`empty update body` / flag list). MCP uses assertProjectUpdateBody before project resolve. Body I/O (--body-file/--stdin) stays in the CLI adapter. Health enum validated in fromCli; MCP uses zod enum.",
  fromCli: buildProjectUpdateCreateInputFromCli,
  fromMcp: buildProjectUpdateCreateInputFromMcp,
  execute: executeProjectUpdateCreate,
} satisfies SurfaceOperationContract<
  ProjectUpdateCreateInput,
  ProjectUpdateCreateExecutionResult,
  ProjectUpdateCreateCliInput,
  ProjectUpdateCreateMcpInput
>;

const projectUpdateEditNonLiveReason =
  "Covered by scripts/live-discovery-smoke.mjs (P0/P1 coverage surfaces), not the main live step inventory.";

export const projectUpdateUpdateOperation = {
  id: "project_updates.update",
  domain: "projects",
  resource: "project_update",
  action: "update",
  title: "Update project update",
  description: "Edit a project status update by UUID.",
  cli: {
    command: "project-update update",
    nonLiveReason: projectUpdateEditNonLiveReason,
  },
  mcp: {
    tool: "update_project_update",
    title: "Update project update",
    description: "Edit a project status update by UUID.",
    annotations: {
      title: "Update project update",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildProjectUpdateUpdateInputFromCli,
  fromMcp: buildProjectUpdateUpdateInputFromMcp,
  execute: executeProjectUpdateUpdate,
} satisfies SurfaceOperationContract<
  ProjectUpdateUpdateInput,
  ListedProjectUpdate,
  ProjectUpdateUpdateCliInput,
  ProjectUpdateUpdateMcpInput
>;

export const projectUpdateDeleteOperation = {
  id: "project_updates.soft_delete",
  domain: "projects",
  resource: "project_update",
  action: "soft_delete",
  title: "Delete project update",
  description:
    "Archive (soft-delete) a project status update by UUID. Requires confirm: true. Idempotent — re-delete returns `{status: 'already-absent'}`.",
  cli: {
    command: "project-update soft-delete",
    nonLiveReason: projectUpdateEditNonLiveReason,
  },
  mcp: {
    tool: "soft_delete_project_update",
    title: "Delete project update",
    description:
      "Archive (soft-delete) a project status update by UUID. Requires confirm: true. Idempotent — re-delete returns `{status: 'already-absent'}`.",
    annotations: {
      title: "Delete project update",
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
  fromCli: buildProjectUpdateDeleteInputFromCli,
  fromMcp: buildProjectUpdateDeleteInputFromMcp,
  execute: executeProjectUpdateDelete,
} satisfies SurfaceOperationContract<
  ProjectUpdateDeleteInput,
  ProjectUpdateDeleteExecutionResult,
  ProjectUpdateDeleteCliInput,
  ProjectUpdateDeleteMcpInput
>;

export const PROJECT_UPDATE_SURFACE_OPERATIONS = [
  projectUpdateListOperation,
  projectUpdateCreateOperation,
  projectUpdateUpdateOperation,
  projectUpdateDeleteOperation,
] as const;

// ── MCP input schemas ───────────────────────────────────────────────────────

export function buildProjectUpdateListMcpInputSchema(workspaceDescription: string) {
  return {
    project: z.string().describe("Project name or UUID."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildProjectUpdateCreateMcpInputSchema(workspaceDescription: string) {
  return {
    project: z.string().describe("Project name or UUID."),
    body: z.string(),
    health: z.enum(PROJECT_UPDATE_HEALTH_VALUES).optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildProjectUpdateUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Project update UUID."),
    body: z.string().optional(),
    health: z.enum(PROJECT_UPDATE_HEALTH_VALUES).optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildProjectUpdateDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Project update UUID."),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export { PROJECT_UPDATE_MCP_PROJECT_NOT_FOUND_HINT };
