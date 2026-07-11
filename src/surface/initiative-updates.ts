import { z } from "zod";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import {
  assertInitiativeUpdateBody,
  createInitiativeUpdate,
  type InitiativeHealth,
  type ListedInitiativeUpdate,
  listInitiativeUpdates,
  resolveExistingInitiativeId,
  resolveInitiativeId,
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

// ── Builders ────────────────────────────────────────────────────────────────

export function buildInitiativeUpdateListInputFromCli(
  input: InitiativeUpdateListCliInput,
): InitiativeUpdateListInput {
  return parseSurfaceInput("initiative_updates.list", initiativeUpdateListCanonicalSchema, {
    initiative: input.initiative,
    initiativeResolve: "existing",
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
    inputSchemaKeys: ["initiative", "workspace"],
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
    inputSchemaKeys: ["initiative", "body", "health", "workspace"],
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

export const INITIATIVE_UPDATE_SURFACE_OPERATIONS = [
  initiativeUpdateListOperation,
  initiativeUpdateCreateOperation,
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
