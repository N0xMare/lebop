import type { z } from "zod";
import type { SurfaceOperationMetadata } from "../../surface/contracts.ts";
import type { RegisteredMcpToolDefinition } from "../types.ts";

export function mcpToolConfig(
  operation: SurfaceOperationMetadata,
  inputSchema: z.ZodRawShape,
): RegisteredMcpToolDefinition["config"] {
  if (!operation.mcp) {
    throw new Error(`Surface operation ${operation.id} has no MCP mapping`);
  }

  return {
    title: operation.mcp.title ?? operation.title,
    description: operation.mcp.description ?? operation.description,
    inputSchema,
    annotations: operation.mcp.annotations,
  };
}
