import { z } from "zod";
import { resolveConfig } from "../lib/config.ts";
import { NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import {
  createLabel,
  deleteLabel,
  type LabelScope,
  type ListedLabel,
  listLabels,
  resolveLabelSelectorToId,
} from "../lib/labels.ts";
import { getTeam } from "../lib/teams.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, teamArg, workspaceArg } from "./schema.ts";

// ---------------------------------------------------------------------------
// Canonical inputs / results
// ---------------------------------------------------------------------------

export type LabelListScopeType = "team" | "workspace" | "all";

export interface LabelListInput {
  team?: string;
  workspaceOnly?: boolean;
  all?: boolean;
}

export interface LabelListCliInput {
  opts: {
    team?: string;
    workspaceOnly?: boolean;
    all?: boolean;
  };
}

export type LabelListMcpInput = Record<string, unknown> & {
  team?: string;
  workspace_only?: boolean;
  all?: boolean;
};

export interface LabelListExecutionResult {
  scope: { type: LabelListScopeType; team: string | null };
  team: string | null;
  count: number;
  labels: ListedLabel[];
}

export interface LabelCreateInput {
  name: string;
  scope: LabelScope;
  team?: string;
  teamId?: string;
  color?: string;
  description?: string;
}

export interface LabelCreateCliInput {
  name: string;
  opts: {
    team?: string;
    workspaceScoped?: boolean;
    color?: string;
    description?: string;
  };
}

export type LabelCreateMcpInput = Record<string, unknown> & {
  name: string;
  scope?: LabelScope;
  team?: string;
  team_id?: string;
  color?: string;
  description?: string;
};

export interface LabelCreateExecutionResult {
  label: ListedLabel;
  scope: LabelScope;
  team: string | null;
  team_id: string | null;
  /** Team key to pass to invalidateTeamMetadata (undefined for workspace labels). */
  invalidateTeam: string | undefined;
  /** Repo hash used when resolving team scope via config (when available). */
  repoHash: string | undefined;
}

export interface LabelCreateDeps {
  /**
   * Resolve a team key (or configured default when omitted) to UUID + key +
   * repoHash. CLI uses getTeamMetadata; MCP uses getTeam / resolveTeamSelectorToId
   * so request shapes stay behavior-frozen.
   */
  resolveTeamKey: (team: string | undefined) => Promise<{
    teamId: string;
    teamKey: string;
    repoHash: string;
  }>;
}

export interface LabelDeleteInput {
  selector: string;
  scope: LabelScope;
  team?: string;
}

export interface LabelDeleteCliInput {
  nameOrId: string;
  opts: {
    team?: string;
    scope?: string;
    yes?: boolean;
  };
}

export type LabelDeleteMcpInput = Record<string, unknown> & {
  id?: string;
  name_or_id?: string;
  scope?: LabelScope;
  team?: string;
  confirm?: boolean;
};

export interface LabelDeleteExecutionResult {
  id: string;
  selector: string;
  scope: LabelScope;
  team: string | null;
  status: "deleted" | "already-absent";
  success: boolean;
  /** True when mutation ran (status === "deleted"); used for cache invalidation. */
  mutated: boolean;
}

export interface LabelLookupInput {
  name: string;
  scope: LabelScope;
  team?: string;
}

export type LabelLookupMcpInput = Record<string, unknown> & {
  name: string;
  scope?: LabelScope;
  team?: string;
};

export interface LabelLookupExecutionResult {
  label: ListedLabel | null;
  scope: LabelScope;
  team: string | null;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const labelScopeSchema = z.enum(["team", "workspace"]);

const labelListCanonicalSchema = z
  .object({
    team: z.string().optional(),
    workspaceOnly: z.boolean().optional(),
    all: z.boolean().optional(),
  })
  .strict();

const labelCreateCanonicalSchema = z
  .object({
    name: z.string(),
    scope: labelScopeSchema,
    team: z.string().optional(),
    teamId: z.string().optional(),
    color: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

const labelDeleteCanonicalSchema = z
  .object({
    selector: z.string(),
    scope: labelScopeSchema,
    team: z.string().optional(),
  })
  .strict();

const labelLookupCanonicalSchema = z
  .object({
    name: z.string(),
    scope: labelScopeSchema,
    team: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Input builders
// ---------------------------------------------------------------------------

export function buildLabelListInputFromCli(input: LabelListCliInput): LabelListInput {
  return parseSurfaceInput("labels.list", labelListCanonicalSchema, {
    team: input.opts.team,
    workspaceOnly: input.opts.workspaceOnly,
    all: input.opts.all,
  });
}

export function buildLabelListInputFromMcp(input: LabelListMcpInput): LabelListInput {
  return parseSurfaceInput("labels.list", labelListCanonicalSchema, {
    team: input.team,
    workspaceOnly: input.workspace_only,
    all: input.all,
  });
}

export function buildLabelCreateInputFromCli(input: LabelCreateCliInput): LabelCreateInput {
  return parseSurfaceInput("labels.create", labelCreateCanonicalSchema, {
    name: input.name,
    scope: input.opts.workspaceScoped ? "workspace" : "team",
    team: input.opts.team,
    color: input.opts.color,
    description: input.opts.description,
  });
}

export function buildLabelCreateInputFromMcp(input: LabelCreateMcpInput): LabelCreateInput {
  if (input.team && input.team_id) {
    throw new ValidationError(
      "create_label accepts either team or team_id, not both",
      "pass team for a key selector, or team_id for a UUID selector",
    );
  }
  const scope: LabelScope = input.scope ?? "team";
  if (scope === "workspace" && (input.team || input.team_id)) {
    throw new ValidationError(
      "scope='workspace' forbids team and team_id",
      "drop team/team_id, or set scope='team' to scope the label to that team",
    );
  }
  return parseSurfaceInput("labels.create", labelCreateCanonicalSchema, {
    name: input.name,
    scope,
    team: input.team,
    teamId: input.team_id,
    color: input.color,
    description: input.description,
  });
}

export function buildLabelDeleteInputFromCli(input: LabelDeleteCliInput): LabelDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to delete label ${input.nameOrId} without --yes`,
      "re-run with --yes to confirm. This removes the label from every issue that uses it.",
    );
  }
  return parseSurfaceInput("labels.delete", labelDeleteCanonicalSchema, {
    selector: input.nameOrId,
    scope: normalizeDeleteScope(input.opts.scope),
    team: input.opts.team,
  });
}

export function buildLabelDeleteInputFromMcp(input: LabelDeleteMcpInput): LabelDeleteInput {
  if (input.id && input.name_or_id) {
    throw new ValidationError(
      "delete_label accepts either id or name_or_id, not both",
      "pass id for UUID deletion, or name_or_id with optional team for name lookup",
    );
  }
  const selector = input.id ?? input.name_or_id;
  if (!selector) {
    throw new ValidationError(
      "delete_label requires id or name_or_id",
      "pass id for UUID deletion, or name_or_id with optional team for name lookup",
    );
  }
  const scope: LabelScope = input.scope ?? "team";
  if (scope === "workspace" && input.team) {
    throw new ValidationError(
      "scope='workspace' forbids team",
      "drop team, or set scope='team' to delete a team-scoped label",
    );
  }
  return parseSurfaceInput("labels.delete", labelDeleteCanonicalSchema, {
    selector,
    scope,
    team: input.team,
  });
}

export function buildLabelLookupInputFromMcp(input: LabelLookupMcpInput): LabelLookupInput {
  return parseSurfaceInput("labels.lookup_by_name", labelLookupCanonicalSchema, {
    name: input.name,
    scope: input.scope ?? "team",
    team: input.team,
  });
}

function normalizeDeleteScope(scope: string | undefined): LabelScope {
  if (scope === undefined || scope === "team") return "team";
  if (scope === "workspace") return "workspace";
  throw new ValidationError(
    "label delete --scope must be team or workspace",
    "pass --scope team or --scope workspace",
  );
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function executeLabelList(input: LabelListInput): Promise<LabelListExecutionResult> {
  const teamScope =
    input.workspaceOnly || input.all
      ? undefined
      : (await resolveConfig({ teamOverride: input.team })).team;
  if (!input.workspaceOnly && !input.all && teamScope) {
    const team = await getTeam(teamScope);
    if (!team) {
      throw new NotFoundError(
        `team not found: ${teamScope}`,
        "use `lebop teams` to see available team keys; or pass --workspace-only / workspace_only:true to skip team scoping",
      );
    }
  }
  const labels = await listLabels({
    team: teamScope,
    workspaceOnly: input.workspaceOnly,
    all: input.all,
  });
  const scope = input.all
    ? { type: "all" as const, team: null }
    : input.workspaceOnly
      ? { type: "workspace" as const, team: null }
      : { type: "team" as const, team: teamScope ?? null };
  return {
    scope,
    team: teamScope ?? null,
    count: labels.length,
    labels,
  };
}

export function labelListPayload(result: LabelListExecutionResult) {
  return {
    scope: result.scope,
    team: result.team,
    count: result.count,
    labels: result.labels,
  };
}

export async function executeLabelCreate(
  input: LabelCreateInput,
  deps: LabelCreateDeps,
): Promise<LabelCreateExecutionResult> {
  if (input.scope === "workspace") {
    if (input.team || input.teamId) {
      throw new ValidationError(
        "scope='workspace' forbids team and team_id",
        "drop team/team_id, or set scope='team' to scope the label to that team",
      );
    }
    const label = await createLabel({
      name: input.name,
      color: input.color,
      description: input.description,
    });
    return {
      label,
      scope: "workspace",
      team: null,
      team_id: null,
      invalidateTeam: undefined,
      repoHash: undefined,
    };
  }

  if (input.team && input.teamId) {
    throw new ValidationError(
      "create_label accepts either team or team_id, not both",
      "pass team for a key selector, or team_id for a UUID selector",
    );
  }

  let teamId: string;
  let teamKey: string | undefined;
  let repoHash: string | undefined;
  if (input.teamId) {
    teamId = input.teamId;
  } else {
    const resolved = await deps.resolveTeamKey(input.team);
    teamId = resolved.teamId;
    teamKey = resolved.teamKey;
    repoHash = resolved.repoHash;
  }

  const label = await createLabel({
    name: input.name,
    teamId,
    color: input.color,
    description: input.description,
  });
  const resolvedTeamKey = label.team?.key ?? teamKey ?? null;
  return {
    label,
    scope: "team",
    team: resolvedTeamKey,
    team_id: teamId,
    invalidateTeam: resolvedTeamKey ?? undefined,
    repoHash,
  };
}

export async function executeLabelDelete(
  input: LabelDeleteInput,
): Promise<LabelDeleteExecutionResult> {
  const resolved = await resolveLabelSelectorToId(input.selector, input.scope, input.team);
  const id = resolved.id;
  const r = await tryIdempotentDelete(() => deleteLabel(id));
  const succeeded = r.status === "deleted" && Boolean(r.result);
  return {
    id,
    selector: input.selector,
    scope: resolved.scope,
    team: resolved.team,
    status: r.status,
    success: succeeded,
    mutated: r.status === "deleted",
  };
}

export async function executeLabelLookup(
  input: LabelLookupInput,
): Promise<LabelLookupExecutionResult> {
  try {
    const resolved = await resolveLabelSelectorToId(input.name, input.scope, input.team);
    return {
      label: resolved.label,
      scope: resolved.scope,
      team: resolved.team,
    };
  } catch (err) {
    if (err instanceof NotFoundError) {
      return {
        label: null,
        scope: input.scope,
        team: input.team ?? null,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MCP input schemas
// ---------------------------------------------------------------------------

export function buildLabelListMcpInputSchema(workspaceDescription: string) {
  return {
    team: teamArg.describe(
      "Team key. Omit to use the configured default team; pass all=true for every visible label or workspace_only=true for workspace labels.",
    ),
    workspace_only: z.boolean().optional(),
    all: z.boolean().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildLabelCreateMcpInputSchema(workspaceDescription: string) {
  return {
    name: z.string(),
    scope: z
      .enum(["team", "workspace"])
      .optional()
      .describe(
        "Discriminator: 'team' uses team/team_id or the configured default team; 'workspace' forbids both. Defaults to team scope for CLI parity.",
      ),
    team: teamArg.describe("Team key, e.g. NOX. Mutually exclusive with team_id."),
    team_id: z.string().optional().describe("Team UUID. Mutually exclusive with team."),
    color: z.string().optional().describe("Hex color (e.g. '#ff0000')."),
    description: z.string().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildLabelDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string().optional().describe("Label UUID. Preserved for backward compatibility."),
    name_or_id: z
      .string()
      .optional()
      .describe("Label name or UUID. When a name is passed, team can scope lookup."),
    scope: z
      .enum(["team", "workspace"])
      .optional()
      .describe("Name lookup scope. Defaults to team scope using team or configured default team."),
    team: teamArg.describe("Team key for name lookup."),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildLabelLookupMcpInputSchema(workspaceDescription: string) {
  return {
    name: z.string(),
    scope: z
      .enum(["team", "workspace"])
      .optional()
      .describe("Lookup scope. Defaults to team scope using team or configured default team."),
    team: teamArg,
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

// ---------------------------------------------------------------------------
// Operation contracts
// ---------------------------------------------------------------------------

const listLabelsDescription = "List labels in a team, workspace-only, or all visible.";
const createLabelDescription =
  'Create a team-scoped or workspace-scoped label. Pass `scope: "team"` with `team` (key) or `team_id` (UUID) for a team label, or `scope: "workspace"` for a workspace-wide label. NOT retry-wrapped (would duplicate).';
const deleteLabelDescription =
  "Delete by UUID or exact label name. Requires confirm:true. Idempotent — re-deleting an already-absent UUID returns `{status: 'already-absent'}` without error.";
const lookupLabelDescription =
  "Returns the matching label in the same scope semantics used by delete_label. Defaults to team scope.";

export const labelListOperation = {
  id: "labels.list",
  domain: "labels",
  resource: "label",
  action: "list",
  title: "List Linear labels",
  description: listLabelsDescription,
  cli: {
    command: "label list",
    liveSteps: ["cli:label list --json", "cli:label list --workspace-only --json"],
  },
  mcp: {
    tool: "list_labels",
    title: "List Linear labels",
    description: listLabelsDescription,
    annotations: {
      title: "List Linear labels",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["team", "workspace_only", "all", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildLabelListInputFromCli,
  fromMcp: buildLabelListInputFromMcp,
  execute: executeLabelList,
} satisfies SurfaceOperationContract<
  LabelListInput,
  LabelListExecutionResult,
  LabelListCliInput,
  LabelListMcpInput
>;

export const labelCreateOperation = {
  id: "labels.create",
  domain: "labels",
  resource: "label",
  action: "create",
  title: "Create a Linear label",
  description: createLabelDescription,
  cli: {
    command: "label create",
    liveSteps: ["cli:label create --json"],
  },
  mcp: {
    tool: "create_label",
    title: "Create a Linear label",
    description: createLabelDescription,
    annotations: {
      title: "Create a Linear label",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaKeys: ["name", "scope", "team", "team_id", "color", "description", "workspace"],
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  notes:
    "CLI uses getTeamMetadata for team UUID resolution; MCP uses getTeam/resolveTeamSelectorToId. Create is not retry-wrapped.",
  fromCli: buildLabelCreateInputFromCli,
  fromMcp: buildLabelCreateInputFromMcp,
  // executeLabelCreate takes LabelCreateDeps (CLI vs MCP team resolution asymmetry).
} satisfies SurfaceOperationContract<
  LabelCreateInput,
  LabelCreateExecutionResult,
  LabelCreateCliInput,
  LabelCreateMcpInput
>;

export const labelDeleteOperation = {
  id: "labels.delete",
  domain: "labels",
  resource: "label",
  action: "delete",
  title: "Delete a Linear label",
  description: deleteLabelDescription,
  cli: {
    command: "label delete",
    liveSteps: ["cli:label delete --json"],
  },
  mcp: {
    tool: "delete_label",
    title: "Delete a Linear label",
    description: deleteLabelDescription,
    annotations: {
      title: "Delete a Linear label",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["id", "name_or_id", "scope", "team", "confirm", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildLabelDeleteInputFromCli,
  fromMcp: buildLabelDeleteInputFromMcp,
  execute: executeLabelDelete,
} satisfies SurfaceOperationContract<
  LabelDeleteInput,
  LabelDeleteExecutionResult,
  LabelDeleteCliInput,
  LabelDeleteMcpInput
>;

export const labelLookupByNameOperation = {
  id: "labels.lookup_by_name",
  domain: "labels",
  resource: "label",
  action: "get",
  title: "Resolve a label name to a UUID",
  description: lookupLabelDescription,
  mcp: {
    tool: "lookup_label_by_name",
    title: "Resolve a label name to a UUID",
    description: lookupLabelDescription,
    annotations: {
      title: "Resolve a label name to a UUID",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["name", "scope", "team", "workspace"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  exception: {
    kind: "mcp_only",
    reason: "MCP-only delete preflight helper",
  },
  notes: "Soft-null on NotFoundError (returns label: null) for agent-friendly preflight.",
  fromMcp: buildLabelLookupInputFromMcp,
  execute: executeLabelLookup,
} satisfies SurfaceOperationContract<
  LabelLookupInput,
  LabelLookupExecutionResult,
  never,
  LabelLookupMcpInput
>;

export const LABELS_SURFACE_OPERATIONS = [
  labelListOperation,
  labelCreateOperation,
  labelDeleteOperation,
  labelLookupByNameOperation,
] as const;
