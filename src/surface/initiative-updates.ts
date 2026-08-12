import { z } from "zod";
import { NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import {
  assertInitiativeUpdateBody,
  createInitiativeUpdate,
  deleteInitiativeUpdateEntry,
  type InitiativeHealth,
  type ListedInitiativeUpdate,
  listInitiativeUpdates,
  resolveExistingInitiativeId,
  resolveInitiativeId,
  updateInitiativeUpdateEntry,
} from "../lib/initiatives.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

const HEALTH_VALUES = ["onTrack", "atRisk", "offTrack"] as const;

// ── Canonical inputs ────────────────────────────────────────────────────────

export interface InitiativeUpdateListInput {
  initiative: string;
  /**
   * How to resolve `initiative`:
   * - `"existing"` (CLI): `resolveExistingInitiativeId`
   * - `"name-or-id"` (MCP): `resolveInitiativeId`
   */
  initiativeResolve: "existing" | "name-or-id";
  initiativeNotFoundHint?: string;
}

export interface InitiativeUpdateListCliInput {
  initiative: string;
}

export type InitiativeUpdateListMcpInput = Record<string, unknown> & {
  initiative: string;
};

export interface InitiativeUpdateCreateInput {
  initiative: string;
  body: string;
  health?: InitiativeHealth;
  initiativeNotFoundHint?: string;
}

export interface InitiativeUpdateCreateCliInput {
  initiative: string;
  body: string;
  health?: string;
}

export type InitiativeUpdateCreateMcpInput = Record<string, unknown> & {
  initiative: string;
  body: string;
  health?: InitiativeHealth;
};

export interface InitiativeUpdateUpdateInput {
  id: string;
  body?: string;
  health?: InitiativeHealth;
}

export interface InitiativeUpdateUpdateCliInput {
  id: string;
  body?: string;
  health?: string;
}

export type InitiativeUpdateUpdateMcpInput = Record<string, unknown> & {
  id: string;
  body?: string;
  health?: InitiativeHealth;
};

export interface InitiativeUpdateDeleteInput {
  id: string;
}

export interface InitiativeUpdateDeleteCliInput {
  id: string;
  opts: { yes?: boolean };
}

export type InitiativeUpdateDeleteMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
};

// ── Results ─────────────────────────────────────────────────────────────────

export interface InitiativeUpdateListExecutionResult {
  initiative_id: string;
  count: number;
  updates: ListedInitiativeUpdate[];
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const initiativeUpdateListCanonicalSchema = z
  .object({
    initiative: z.string(),
    initiativeResolve: z.enum(["existing", "name-or-id"]),
    initiativeNotFoundHint: z.string().optional(),
  })
  .strict();

const initiativeUpdateCreateCanonicalSchema = z
  .object({
    initiative: z.string(),
    body: z.string(),
    health: z.enum(HEALTH_VALUES).optional(),
    initiativeNotFoundHint: z.string().optional(),
  })
  .strict();

const initiativeUpdateUpdateCanonicalSchema = z
  .object({
    id: z.string(),
    body: z.string().optional(),
    health: z.enum(HEALTH_VALUES).optional(),
  })
  .strict();

const initiativeUpdateDeleteCanonicalSchema = z.object({ id: z.string() }).strict();

// ── Builders ────────────────────────────────────────────────────────────────

export function buildInitiativeUpdateListInputFromCli(
  input: InitiativeUpdateListCliInput,
): InitiativeUpdateListInput {
  // Use name-or-id (same as create/MCP): UUID passes through; avoid extra
  // getInitiative existence probe that can false-negative under live races.
  return parseSurfaceInput("initiative_updates.list", initiativeUpdateListCanonicalSchema, {
    initiative: input.initiative,
    initiativeResolve: "name-or-id",
  });
}

export function buildInitiativeUpdateListInputFromMcp(
  input: InitiativeUpdateListMcpInput,
): InitiativeUpdateListInput {
  return parseSurfaceInput("initiative_updates.list", initiativeUpdateListCanonicalSchema, {
    initiative: input.initiative,
    initiativeResolve: "name-or-id",
    initiativeNotFoundHint:
      "pass the initiative name or UUID; run list_initiatives to discover ids",
  });
}

export function buildInitiativeUpdateCreateInputFromCli(
  input: InitiativeUpdateCreateCliInput,
): InitiativeUpdateCreateInput {
  if (!input.body.trim()) {
    throw new ValidationError("empty update body", "pass --body, --body-file, or --stdin");
  }
  let health: InitiativeHealth | undefined;
  if (input.health !== undefined) {
    if (!(HEALTH_VALUES as readonly string[]).includes(input.health)) {
      throw new ValidationError(
        `invalid --health "${input.health}". expected: ${HEALTH_VALUES.join(", ")}`,
        `expected one of: ${HEALTH_VALUES.join(", ")}`,
      );
    }
    health = input.health as InitiativeHealth;
  }
  return parseSurfaceInput("initiative_updates.create", initiativeUpdateCreateCanonicalSchema, {
    initiative: input.initiative,
    body: input.body,
    health,
  });
}

export function buildInitiativeUpdateCreateInputFromMcp(
  input: InitiativeUpdateCreateMcpInput,
): InitiativeUpdateCreateInput {
  assertInitiativeUpdateBody(input.body);
  return parseSurfaceInput("initiative_updates.create", initiativeUpdateCreateCanonicalSchema, {
    initiative: input.initiative,
    body: input.body,
    health: input.health,
    initiativeNotFoundHint:
      "pass the initiative name or UUID; run list_initiatives to discover ids",
  });
}

function parseOptionalInitiativeHealth(
  health: string | undefined,
  channel: "cli" | "mcp",
): InitiativeHealth | undefined {
  if (health === undefined) return undefined;
  if (!(HEALTH_VALUES as readonly string[]).includes(health)) {
    throw new ValidationError(
      channel === "cli"
        ? `invalid --health "${health}". expected: ${HEALTH_VALUES.join(", ")}`
        : `invalid health "${health}"`,
      `expected one of: ${HEALTH_VALUES.join(", ")}`,
    );
  }
  return health as InitiativeHealth;
}

function hasInitiativeUpdateUpdateFields(update: InitiativeUpdateUpdateInput): boolean {
  return update.body !== undefined || update.health !== undefined;
}

export function buildInitiativeUpdateUpdateInputFromCli(
  input: InitiativeUpdateUpdateCliInput,
): InitiativeUpdateUpdateInput {
  const update: InitiativeUpdateUpdateInput = {
    id: input.id,
    health: parseOptionalInitiativeHealth(input.health, "cli"),
  };
  if (input.body !== undefined) {
    if (!input.body.trim()) {
      throw new ValidationError("empty update body", "pass --body, --body-file, or --stdin");
    }
    update.body = input.body;
  }
  if (!hasInitiativeUpdateUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one of --body / --health",
      "pass at least one update field",
    );
  }
  return parseSurfaceInput(
    "initiative_updates.update",
    initiativeUpdateUpdateCanonicalSchema,
    update,
  );
}

export function buildInitiativeUpdateUpdateInputFromMcp(
  input: InitiativeUpdateUpdateMcpInput,
): InitiativeUpdateUpdateInput {
  const update: InitiativeUpdateUpdateInput = { id: input.id };
  if (input.body !== undefined) {
    assertInitiativeUpdateBody(input.body);
    update.body = input.body;
  }
  if (input.health !== undefined) update.health = input.health;
  if (!hasInitiativeUpdateUpdateFields(update)) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass at least one of body, health",
    );
  }
  return parseSurfaceInput(
    "initiative_updates.update",
    initiativeUpdateUpdateCanonicalSchema,
    update,
  );
}

export function buildInitiativeUpdateDeleteInputFromCli(
  input: InitiativeUpdateDeleteCliInput,
): InitiativeUpdateDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to delete initiative update ${input.id} without --yes`,
      "re-run with --yes to confirm.",
    );
  }
  return parseSurfaceInput(
    "initiative_updates.soft_delete",
    initiativeUpdateDeleteCanonicalSchema,
    {
      id: input.id,
    },
  );
}

export function buildInitiativeUpdateDeleteInputFromMcp(
  input: InitiativeUpdateDeleteMcpInput,
): InitiativeUpdateDeleteInput {
  return parseSurfaceInput(
    "initiative_updates.soft_delete",
    initiativeUpdateDeleteCanonicalSchema,
    {
      id: input.id,
    },
  );
}

// ── Execute ─────────────────────────────────────────────────────────────────

export async function executeInitiativeUpdateList(
  input: InitiativeUpdateListInput,
): Promise<InitiativeUpdateListExecutionResult> {
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
  const updates = await listInitiativeUpdates(initiativeId);
  return {
    initiative_id: initiativeId,
    count: updates.length,
    updates,
  };
}

export function initiativeUpdateListPayload(result: InitiativeUpdateListExecutionResult) {
  return {
    initiative_id: result.initiative_id,
    count: result.count,
    updates: result.updates,
  };
}

export interface InitiativeUpdateCreateExecutionResult {
  initiative_id: string;
  initiative_update: ListedInitiativeUpdate;
}

export async function executeInitiativeUpdateCreate(
  input: InitiativeUpdateCreateInput,
): Promise<InitiativeUpdateCreateExecutionResult> {
  const initiativeId = await resolveInitiativeId(input.initiative);
  if (!initiativeId) {
    throw new NotFoundError(
      `initiative not found: ${input.initiative}`,
      input.initiativeNotFoundHint,
    );
  }
  const initiative_update = await createInitiativeUpdate({
    initiativeId,
    body: input.body,
    health: input.health,
  });
  return { initiative_id: initiativeId, initiative_update };
}

export async function executeInitiativeUpdateUpdate(
  input: InitiativeUpdateUpdateInput,
): Promise<ListedInitiativeUpdate> {
  return updateInitiativeUpdateEntry(input.id, {
    body: input.body,
    health: input.health,
  });
}

export type InitiativeUpdateDeleteExecutionResult = {
  id: string;
  status: "deleted" | "already-absent";
  success: boolean;
  archived: boolean;
};

export async function executeInitiativeUpdateDelete(
  input: InitiativeUpdateDeleteInput,
): Promise<InitiativeUpdateDeleteExecutionResult> {
  const r = await tryIdempotentDelete(() => deleteInitiativeUpdateEntry(input.id));
  return {
    id: input.id,
    status: r.status,
    success: r.status === "deleted" && Boolean(r.result),
    archived: r.status === "deleted",
  };
}

// ── Operation contracts ─────────────────────────────────────────────────────

export const initiativeUpdateListOperation = {
  id: "initiative_updates.list",
  domain: "initiatives",
  resource: "initiative_update",
  action: "list",
  title: "List initiative status updates",
  description: "Chronological status posts for one initiative.",
  cli: {
    command: "initiative-update list",
    liveSteps: ["cli:initiative-update list --json"],
  },
  mcp: {
    tool: "list_initiative_updates",
    title: "List initiative status updates",
    description: "Chronological status posts for one initiative.",
    annotations: {
      title: "List initiative status updates",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes:
    "CLI resolves via resolveExistingInitiativeId; MCP via resolveInitiativeId (UUID must not existence-check on MCP path).",
  fromCli: buildInitiativeUpdateListInputFromCli,
  fromMcp: buildInitiativeUpdateListInputFromMcp,
} satisfies SurfaceOperationContract<
  InitiativeUpdateListInput,
  InitiativeUpdateListExecutionResult,
  InitiativeUpdateListCliInput,
  InitiativeUpdateListMcpInput
>;

export const initiativeUpdateCreateOperation = {
  id: "initiative_updates.create",
  domain: "initiatives",
  resource: "initiative_update",
  action: "create",
  title: "Post an initiative status update (with health)",
  description: "NOT retry-wrapped (would duplicate).",
  cli: {
    command: "initiative-update create",
    liveSteps: ["cli:initiative-update create --json"],
  },
  mcp: {
    tool: "create_initiative_update",
    title: "Post an initiative status update (with health)",
    description: "NOT retry-wrapped (would duplicate).",
    annotations: {
      title: "Post an initiative status update (with health)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  notes:
    "CLI empty-body message is `empty update body`; MCP uses assertInitiativeUpdateBody (`empty initiative update body`). Body I/O (--body/--body-file/--stdin) stays in CLI adapter.",
  fromCli: buildInitiativeUpdateCreateInputFromCli,
  fromMcp: buildInitiativeUpdateCreateInputFromMcp,
} satisfies SurfaceOperationContract<
  InitiativeUpdateCreateInput,
  InitiativeUpdateCreateExecutionResult,
  InitiativeUpdateCreateCliInput,
  InitiativeUpdateCreateMcpInput
>;

const initiativeUpdateEditNonLiveReason =
  "Covered by scripts/live-discovery-smoke.mjs (P0/P1 coverage surfaces), not the main live step inventory.";

export const initiativeUpdateUpdateOperation = {
  id: "initiative_updates.update",
  domain: "initiatives",
  resource: "initiative_update",
  action: "update",
  title: "Update initiative update",
  description: "Edit an initiative status update by UUID.",
  cli: {
    command: "initiative-update update",
    nonLiveReason: initiativeUpdateEditNonLiveReason,
  },
  mcp: {
    tool: "update_initiative_update",
    title: "Update initiative update",
    description: "Edit an initiative status update by UUID.",
    annotations: {
      title: "Update initiative update",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildInitiativeUpdateUpdateInputFromCli,
  fromMcp: buildInitiativeUpdateUpdateInputFromMcp,
  execute: executeInitiativeUpdateUpdate,
} satisfies SurfaceOperationContract<
  InitiativeUpdateUpdateInput,
  ListedInitiativeUpdate,
  InitiativeUpdateUpdateCliInput,
  InitiativeUpdateUpdateMcpInput
>;

export const initiativeUpdateDeleteOperation = {
  id: "initiative_updates.soft_delete",
  domain: "initiatives",
  resource: "initiative_update",
  action: "soft_delete",
  title: "Delete initiative update",
  description:
    "Archive (soft-delete) an initiative status update by UUID. Requires confirm: true. Idempotent — re-delete returns `{status: 'already-absent'}`.",
  cli: {
    command: "initiative-update soft-delete",
    nonLiveReason: initiativeUpdateEditNonLiveReason,
  },
  mcp: {
    tool: "soft_delete_initiative_update",
    title: "Delete initiative update",
    description:
      "Archive (soft-delete) an initiative status update by UUID. Requires confirm: true. Idempotent — re-delete returns `{status: 'already-absent'}`.",
    annotations: {
      title: "Delete initiative update",
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
  fromCli: buildInitiativeUpdateDeleteInputFromCli,
  fromMcp: buildInitiativeUpdateDeleteInputFromMcp,
  execute: executeInitiativeUpdateDelete,
} satisfies SurfaceOperationContract<
  InitiativeUpdateDeleteInput,
  InitiativeUpdateDeleteExecutionResult,
  InitiativeUpdateDeleteCliInput,
  InitiativeUpdateDeleteMcpInput
>;

export const INITIATIVE_UPDATE_SURFACE_OPERATIONS = [
  initiativeUpdateListOperation,
  initiativeUpdateCreateOperation,
  initiativeUpdateUpdateOperation,
  initiativeUpdateDeleteOperation,
] as const;

// ── MCP input schemas ───────────────────────────────────────────────────────

export function buildInitiativeUpdateListMcpInputSchema(workspaceDescription: string) {
  return {
    initiative: z.string().describe("Initiative name or UUID."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeUpdateCreateMcpInputSchema(workspaceDescription: string) {
  return {
    initiative: z.string(),
    body: z.string(),
    health: z.enum(HEALTH_VALUES).optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeUpdateUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Initiative update UUID."),
    body: z.string().optional(),
    health: z.enum(HEALTH_VALUES).optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildInitiativeUpdateDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().describe("Initiative update UUID."),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}
