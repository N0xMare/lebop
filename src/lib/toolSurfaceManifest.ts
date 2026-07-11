/**
 * Public CLI/MCP inventory exports — derived from SURFACE_OPERATIONS (L2).
 * Do not hand-maintain full tool/command lists here; extend surface ops instead.
 */

import type { SurfaceOperationMetadata } from "../surface/contracts.ts";
import {
  type CliLiveCoverageEntry,
  type CliSurfaceEntry,
  deriveCliLiveCoverageManifest,
  deriveCliSurfaceManifest,
  deriveConditionalMcpConfirmTools,
  deriveMcpSurfaceManifest,
  deriveRequiredCliLiveSteps,
  deriveRequiredMcpConfirmTools,
  type McpSurfaceEntry,
  type ParityMapping,
} from "../surface/deriveToolSurfaceManifest.ts";
import { SURFACE_OPERATIONS } from "../surface/index.ts";

export type { CliLiveCoverageEntry, CliSurfaceEntry, McpSurfaceEntry, ParityMapping };

export const CLI_MCP_PARITY_MANIFEST_VERSION = 1;

/** Direct issue fields for CLI `set` (one field per invocation). Shared constant, not a second inventory. */
export const CLI_SET_ISSUE_FIELDS = [
  "title",
  "description",
  "state",
  "priority",
  "estimate",
  "assignee",
  "labels",
  "parent",
  "project",
  "milestone",
  "cycle",
  "links",
] as const;

/** Direct issue fields for MCP `update_issue` (multi-field per call). Shared constant, not a second inventory. */
export const MCP_UPDATE_ISSUE_FIELDS = [
  "title",
  "description",
  "state",
  "priority",
  "estimate",
  "assignee",
  "labels",
  "labels_add",
  "labels_remove",
  "parent",
  "project",
  "milestone",
  "cycle",
] as const;

const SURFACE_OPS = SURFACE_OPERATIONS as readonly SurfaceOperationMetadata[];

const ISSUE_FIELD_EXTRAS = {
  issueFieldsByCommand: {
    set: CLI_SET_ISSUE_FIELDS,
  },
  issueUpdateModeByCommand: {
    set: "one_field_per_call" as const,
  },
  issueFieldsByTool: {
    update_issue: MCP_UPDATE_ISSUE_FIELDS,
  },
  issueUpdateModeByTool: {
    update_issue: "multi_field_per_call" as const,
  },
};

export const CLI_SURFACE_MANIFEST: CliSurfaceEntry[] = deriveCliSurfaceManifest(
  SURFACE_OPS,
  ISSUE_FIELD_EXTRAS,
);

export const CLI_LIVE_COVERAGE_MANIFEST: CliLiveCoverageEntry[] =
  deriveCliLiveCoverageManifest(SURFACE_OPS);

export const REQUIRED_CLI_LIVE_STEPS = deriveRequiredCliLiveSteps(CLI_LIVE_COVERAGE_MANIFEST);

export const MCP_SURFACE_MANIFEST: McpSurfaceEntry[] = deriveMcpSurfaceManifest(
  SURFACE_OPS,
  ISSUE_FIELD_EXTRAS,
);

export const REQUIRED_MCP_CONFIRM_TOOLS = deriveRequiredMcpConfirmTools(MCP_SURFACE_MANIFEST);

export const CONDITIONAL_MCP_CONFIRM_TOOLS = deriveConditionalMcpConfirmTools(MCP_SURFACE_MANIFEST);
