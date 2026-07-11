import { z } from "zod";
import {
  type FetchedState,
  type FetchedUser,
  lookupStateByName,
  lookupUserByEmail,
} from "../lib/lookups.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

// ---------------------------------------------------------------------------
// Canonical inputs / results
// ---------------------------------------------------------------------------

export interface LookupStateByNameInput {
  team: string;
  name: string;
}

export interface LookupStateByNameCliInput {
  team: string;
  name: string;
}

export type LookupStateByNameMcpInput = Record<string, unknown> & {
  team: string;
  name: string;
};

export interface LookupStateByNameExecutionResult {
  state: FetchedState | null;
}

export interface LookupUserByEmailInput {
  email: string;
}

export interface LookupUserByEmailCliInput {
  email: string;
}

export type LookupUserByEmailMcpInput = Record<string, unknown> & {
  email: string;
};

export interface LookupUserByEmailExecutionResult {
  user: FetchedUser | null;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const lookupStateByNameCanonicalSchema = z
  .object({
    team: z.string(),
    name: z.string(),
  })
  .strict();

const lookupUserByEmailCanonicalSchema = z
  .object({
    email: z.string(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Input builders
// ---------------------------------------------------------------------------

export function buildLookupStateByNameInputFromCli(
  input: LookupStateByNameCliInput,
): LookupStateByNameInput {
  return parseSurfaceInput("lookups.state_by_name", lookupStateByNameCanonicalSchema, {
    team: input.team,
    name: input.name,
  });
}

export function buildLookupStateByNameInputFromMcp(
  input: LookupStateByNameMcpInput,
): LookupStateByNameInput {
  return parseSurfaceInput("lookups.state_by_name", lookupStateByNameCanonicalSchema, {
    team: input.team,
    name: input.name,
  });
}

export function buildLookupUserByEmailInputFromCli(
  input: LookupUserByEmailCliInput,
): LookupUserByEmailInput {
  return parseSurfaceInput("lookups.user_by_email", lookupUserByEmailCanonicalSchema, {
    email: input.email,
  });
}

export function buildLookupUserByEmailInputFromMcp(
  input: LookupUserByEmailMcpInput,
): LookupUserByEmailInput {
  return parseSurfaceInput("lookups.user_by_email", lookupUserByEmailCanonicalSchema, {
    email: input.email,
  });
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function executeLookupStateByName(
  input: LookupStateByNameInput,
): Promise<LookupStateByNameExecutionResult> {
  const state = await lookupStateByName(input.team, input.name);
  return { state };
}

export function lookupStateByNamePayload(result: LookupStateByNameExecutionResult) {
  return { state: result.state };
}

export async function executeLookupUserByEmail(
  input: LookupUserByEmailInput,
): Promise<LookupUserByEmailExecutionResult> {
  const user = await lookupUserByEmail(input.email);
  return { user };
}

export function lookupUserByEmailPayload(result: LookupUserByEmailExecutionResult) {
  return { user: result.user };
}

// ---------------------------------------------------------------------------
// MCP input schemas
// ---------------------------------------------------------------------------

export function buildLookupStateByNameMcpInputSchema(workspaceDescription: string) {
  return {
    team: z.string().describe("Team key (state lookup is team-scoped)."),
    name: z.string().describe("Workflow state name (e.g. 'In Progress'). Case-sensitive."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildLookupUserByEmailMcpInputSchema(workspaceDescription: string) {
  return {
    email: z.string().describe("Workspace user email. Returns null if not found."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

// ---------------------------------------------------------------------------
// Operation contracts
// ---------------------------------------------------------------------------

const lookupStateDescription =
  "Team-scoped exact-name lookup against the Linear workflowStates connection. Case-sensitive. Returns null if not found.";
const lookupUserDescription =
  "Returns the user record or null. Useful before assignee=<uuid> updates.";

export const lookupStateByNameOperation = {
  id: "lookups.state_by_name",
  domain: "lookups",
  resource: "workflow_state",
  action: "get",
  title: "Resolve a workflow state name to a UUID",
  description: lookupStateDescription,
  cli: { command: "lookup state", liveSteps: ["cli:lookup state"] },
  mcp: {
    tool: "lookup_state_by_name",
    title: "Resolve a workflow state name to a UUID",
    description: lookupStateDescription,
    annotations: {
      title: "Resolve a workflow state name to a UUID",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["team", "name", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes: "Soft-null on miss (returns state: null); never throws on not-found.",
  fromCli: buildLookupStateByNameInputFromCli,
  fromMcp: buildLookupStateByNameInputFromMcp,
  execute: executeLookupStateByName,
} satisfies SurfaceOperationContract<
  LookupStateByNameInput,
  LookupStateByNameExecutionResult,
  LookupStateByNameCliInput,
  LookupStateByNameMcpInput
>;

export const lookupUserByEmailOperation = {
  id: "lookups.user_by_email",
  domain: "lookups",
  resource: "user",
  action: "get",
  title: "Resolve a workspace user by email",
  description: lookupUserDescription,
  cli: { command: "lookup user", liveSteps: ["cli:lookup user"] },
  mcp: {
    tool: "lookup_user_by_email",
    title: "Resolve a workspace user by email",
    description: lookupUserDescription,
    annotations: {
      title: "Resolve a workspace user by email",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["email", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  notes: "Soft-null on miss (returns user: null); never throws on not-found.",
  fromCli: buildLookupUserByEmailInputFromCli,
  fromMcp: buildLookupUserByEmailInputFromMcp,
  execute: executeLookupUserByEmail,
} satisfies SurfaceOperationContract<
  LookupUserByEmailInput,
  LookupUserByEmailExecutionResult,
  LookupUserByEmailCliInput,
  LookupUserByEmailMcpInput
>;

export const LOOKUPS_SURFACE_OPERATIONS = [
  lookupStateByNameOperation,
  lookupUserByEmailOperation,
] as const;
