import { z } from "zod";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import { resolveExistingProjectId, resolveProjectId } from "../lib/milestones.ts";
import {
  assertProjectUpdateBody,
  createProjectUpdate,
  type ListedProjectUpdate,
  listProjectUpdates,
  type ProjectHealth,
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
    inputSchemaKeys: ["project", "workspace"],
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
    inputSchemaKeys: ["project", "body", "health", "workspace"],
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

export const PROJECT_UPDATE_SURFACE_OPERATIONS = [
  projectUpdateListOperation,
  projectUpdateCreateOperation,
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

export { PROJECT_UPDATE_MCP_PROJECT_NOT_FOUND_HINT };
