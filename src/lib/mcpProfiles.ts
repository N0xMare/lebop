/**
 * Progressive MCP tool profiles (0.0.6+).
 * Core = minimal agent coding surface; full = entire dual inventory.
 *
 * Core membership is tagged on SURFACE_OPERATIONS (`mcp.profile: "core"`)
 * and derived here — no second handwritten tool inventory.
 */

import { SURFACE_OPERATIONS } from "../surface/index.ts";

export type McpProfile = "core" | "full";

/**
 * Unique MCP tool names tagged `mcp.profile: "core"` on SURFACE_OPERATIONS
 * (first declaration wins for aliases such as list/mine → list_issues).
 */
export function surfaceCoreMcpToolNames(): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const op of SURFACE_OPERATIONS) {
    const mcp = (op as { mcp?: { tool?: string; profile?: string } }).mcp;
    if (
      mcp?.profile === "core" &&
      typeof mcp.tool === "string" &&
      mcp.tool &&
      !seen.has(mcp.tool)
    ) {
      seen.add(mcp.tool);
      names.push(mcp.tool);
    }
  }
  return names;
}

/** Derived core inventory (progressive MCP default profile). */
export const MCP_CORE_TOOLS = surfaceCoreMcpToolNames() as readonly string[];

export type McpCoreToolName = (typeof MCP_CORE_TOOLS)[number];

export function parseMcpProfile(raw: string | undefined | null): McpProfile {
  if (!raw || raw === "core" || raw === "default") return "core";
  if (raw === "full" || raw === "extended" || raw === "all") return "full";
  throw new Error(`unknown MCP profile: ${raw} (use core|full)`);
}

export function filterToolsByProfile<T extends { name: string }>(
  tools: readonly T[],
  profile: McpProfile,
): T[] {
  if (profile === "full") return [...tools];
  const core = new Set<string>(MCP_CORE_TOOLS);
  return tools.filter((t) => core.has(t.name));
}

export function isCoreTool(name: string): boolean {
  return (MCP_CORE_TOOLS as readonly string[]).includes(name);
}
