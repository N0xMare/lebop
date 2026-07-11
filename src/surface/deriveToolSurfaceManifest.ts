/**
 * L2 inventory derivation: CLI/MCP/live manifests from SURFACE_OPERATIONS.
 * toolSurfaceManifest.ts re-exports these — no second handwritten tool inventory.
 */

import type { SurfaceOperationMetadata } from "./contracts.ts";
import { surfaceConfirmPolicy } from "./contracts.ts";

export type ParityMapping =
  | { type: "cli"; tools: string[] }
  | { type: "mcp"; tools: string[] }
  | { type: "exception"; reason: string };

export interface CliSurfaceEntry {
  command: string;
  maps_to: ParityMapping;
  notes?: string;
  issue_fields?: readonly string[];
  issue_update_mode?: "one_field_per_call" | "multi_field_per_call";
}

export type CliLiveCoverageEntry =
  | {
      command: string;
      live_steps: readonly string[];
    }
  | {
      command: string;
      non_live_reason: string;
    };

export interface McpSurfaceEntry {
  tool: string;
  maps_to: ParityMapping;
  notes?: string;
  issue_fields?: readonly string[];
  issue_update_mode?: "one_field_per_call" | "multi_field_per_call";
  destructive_confirm?: "required" | "required_when_mutating" | "not_required";
  live_semantics?: "required" | "optional";
}

export type IssueFieldInventoryExtras = {
  issueFieldsByCommand?: Readonly<Record<string, readonly string[]>>;
  issueUpdateModeByCommand?: Readonly<
    Record<string, "one_field_per_call" | "multi_field_per_call">
  >;
  issueFieldsByTool?: Readonly<Record<string, readonly string[]>>;
  issueUpdateModeByTool?: Readonly<Record<string, "one_field_per_call" | "multi_field_per_call">>;
};

function uniquePreserveOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

function strongestConfirmPolicy(
  current: "required" | "required_when_mutating" | "not_required",
  next: "required" | "required_when_mutating" | "not_required",
): "required" | "required_when_mutating" | "not_required" {
  if (current === "required" || next === "required") return "required";
  if (current === "required_when_mutating" || next === "required_when_mutating") {
    return "required_when_mutating";
  }
  return "not_required";
}

function strongestLiveSemantics(
  current: "required" | "optional" | undefined,
  next: "required" | "optional" | undefined,
): "required" | "optional" | undefined {
  if (current === "required" || next === "required") return "required";
  return current ?? next;
}

function firstNotes(operations: readonly SurfaceOperationMetadata[]): string | undefined {
  for (const operation of operations) {
    const notes = operation.notes?.trim();
    if (notes) return notes;
  }
  return undefined;
}

function groupByCommand(operations: readonly SurfaceOperationMetadata[]): {
  order: string[];
  byCommand: Map<string, SurfaceOperationMetadata[]>;
} {
  const byCommand = new Map<string, SurfaceOperationMetadata[]>();
  const order: string[] = [];

  for (const operation of operations) {
    const command = operation.cli?.command;
    if (!command) continue;
    const existing = byCommand.get(command);
    if (existing) {
      existing.push(operation);
      continue;
    }
    byCommand.set(command, [operation]);
    order.push(command);
  }

  return { order, byCommand };
}

/**
 * One CLI inventory row per distinct `cli.command` across surface ops.
 * Dual-surface → maps_to MCP tools; cli_only (no mcp) → exception reason.
 */
export function deriveCliSurfaceManifest(
  operations: readonly SurfaceOperationMetadata[],
  extras: IssueFieldInventoryExtras = {},
): CliSurfaceEntry[] {
  const { order, byCommand } = groupByCommand(operations);

  return order.flatMap((command) => {
    const ops = byCommand.get(command);
    if (!ops) return [];

    const mcpTools = uniqueSorted(
      ops.flatMap((operation) => (operation.mcp?.tool ? [operation.mcp.tool] : [])),
    );

    const maps_to: ParityMapping =
      mcpTools.length > 0
        ? { type: "mcp", tools: mcpTools }
        : {
            type: "exception",
            reason:
              ops.map((operation) => operation.exception?.reason).find(Boolean) ??
              "CLI-only surface (no MCP dual)",
          };

    const notes = firstNotes(ops);
    const issue_fields = extras.issueFieldsByCommand?.[command];
    const issue_update_mode = extras.issueUpdateModeByCommand?.[command];

    const entry: CliSurfaceEntry = { command, maps_to };
    if (notes) entry.notes = notes;
    if (issue_fields) entry.issue_fields = issue_fields;
    if (issue_update_mode) entry.issue_update_mode = issue_update_mode;
    return [entry];
  });
}

/**
 * One MCP inventory row per distinct `mcp.tool`.
 * Dual-surface → maps_to CLI commands; mcp_only (no cli) → exception reason.
 */
export function deriveMcpSurfaceManifest(
  operations: readonly SurfaceOperationMetadata[],
  extras: IssueFieldInventoryExtras = {},
): McpSurfaceEntry[] {
  type Bucket = {
    ops: SurfaceOperationMetadata[];
    cliCommands: string[];
    confirm: "required" | "required_when_mutating" | "not_required";
    liveSemantics?: "required" | "optional";
  };

  const byTool = new Map<string, Bucket>();
  const order: string[] = [];

  for (const operation of operations) {
    const tool = operation.mcp?.tool;
    if (!tool) continue;

    const existing = byTool.get(tool);
    if (existing) {
      existing.ops.push(operation);
      if (operation.cli?.command) existing.cliCommands.push(operation.cli.command);
      existing.confirm = strongestConfirmPolicy(existing.confirm, surfaceConfirmPolicy(operation));
      existing.liveSemantics = strongestLiveSemantics(
        existing.liveSemantics,
        operation.mcp?.liveSemantics,
      );
      continue;
    }

    byTool.set(tool, {
      ops: [operation],
      cliCommands: operation.cli?.command ? [operation.cli.command] : [],
      confirm: surfaceConfirmPolicy(operation),
      liveSemantics: operation.mcp?.liveSemantics,
    });
    order.push(tool);
  }

  return order.flatMap((tool) => {
    const bucket = byTool.get(tool);
    if (!bucket) return [];

    const cliCommands = uniqueSorted(bucket.cliCommands);

    const maps_to: ParityMapping =
      cliCommands.length > 0
        ? { type: "cli", tools: cliCommands }
        : {
            type: "exception",
            reason:
              bucket.ops.map((operation) => operation.exception?.reason).find(Boolean) ??
              "MCP-only surface (no CLI dual)",
          };

    const notes = firstNotes(bucket.ops);
    const issue_fields = extras.issueFieldsByTool?.[tool];
    const issue_update_mode = extras.issueUpdateModeByTool?.[tool];

    const entry: McpSurfaceEntry = { tool, maps_to };
    if (notes) entry.notes = notes;
    if (issue_fields) entry.issue_fields = issue_fields;
    if (issue_update_mode) entry.issue_update_mode = issue_update_mode;
    if (bucket.confirm !== "not_required") entry.destructive_confirm = bucket.confirm;
    if (bucket.liveSemantics) entry.live_semantics = bucket.liveSemantics;
    return [entry];
  });
}

/**
 * Live coverage policy per CLI command from `cli.liveSteps` / `cli.nonLiveReason`.
 */
export function deriveCliLiveCoverageManifest(
  operations: readonly SurfaceOperationMetadata[],
): CliLiveCoverageEntry[] {
  const { order, byCommand } = groupByCommand(operations);

  return order.flatMap((command): CliLiveCoverageEntry[] => {
    const ops = byCommand.get(command);
    if (!ops) return [];

    const live_steps = uniquePreserveOrder(
      ops.flatMap((operation) => operation.cli?.liveSteps ?? []),
    );
    const non_live_reason = ops
      .map((operation) => operation.cli?.nonLiveReason?.trim())
      .find((reason): reason is string => Boolean(reason));

    if (live_steps.length > 0) {
      return [{ command, live_steps }];
    }
    if (non_live_reason) {
      return [{ command, non_live_reason }];
    }
    throw new Error(
      `Surface op(s) for CLI command "${command}" lack cli.liveSteps and cli.nonLiveReason (ids: ${ops
        .map((operation) => operation.id)
        .join(", ")})`,
    );
  });
}

export function deriveRequiredCliLiveSteps(
  liveCoverage: readonly CliLiveCoverageEntry[],
): string[] {
  return uniquePreserveOrder(
    liveCoverage.flatMap((entry) => ("live_steps" in entry ? [...entry.live_steps] : [])),
  );
}

export function deriveRequiredMcpConfirmTools(manifest: readonly McpSurfaceEntry[]): string[] {
  return manifest
    .filter((entry) => entry.destructive_confirm === "required")
    .map((entry) => entry.tool);
}

export function deriveConditionalMcpConfirmTools(manifest: readonly McpSurfaceEntry[]): string[] {
  return manifest
    .filter((entry) => entry.destructive_confirm === "required_when_mutating")
    .map((entry) => entry.tool);
}
