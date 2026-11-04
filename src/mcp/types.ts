import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

export interface RegisteredMcpToolDefinition {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: z.ZodRawShape;
    annotations?: Record<string, unknown>;
  };
  handler: unknown;
}

export interface McpRegistrar {
  registerTool(name: string, config: RegisteredMcpToolDefinition["config"], handler: unknown): void;
}

export type McpServerLike = McpServer | McpRegistrar;

export type ToolHandlerArgs = Record<string, unknown>;

export type ToolHandlerResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export type McpToolHandler<A extends ToolHandlerArgs = ToolHandlerArgs> = {
  bivarianceHack(args: A): Promise<ToolHandlerResult>;
}["bivarianceHack"];

export interface McpToolSpec<A extends ToolHandlerArgs = ToolHandlerArgs> {
  name: string;
  config: RegisteredMcpToolDefinition["config"];
  handler: McpToolHandler<A>;
}
