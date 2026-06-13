import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  normalizeObjectSchema,
  safeParseAsync,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InvalidArgumentsError } from "../lib/errors.ts";
import { envelopeError, formatToolError } from "./response.ts";
import type { ToolHandlerResult } from "./types.ts";

export function installEnvelopeValidator(server: McpServer): void {
  type RegisteredTool = {
    enabled?: boolean;
    inputSchema?: unknown;
    outputSchema?: unknown;
    execution?: { taskSupport?: string };
    handler: (args: unknown, extra: unknown) => Promise<ToolHandlerResult>;
  };
  const registry = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;

  for (const [name, tool] of Object.entries(registry)) {
    if (tool.outputSchema !== undefined) {
      throw new Error(
        `installEnvelopeValidator: tool "${name}" has an outputSchema, but the envelope validator does not replicate the SDK's output-validation branch. Mirror it from @modelcontextprotocol/sdk/server/mcp.js:185-207 before adding outputSchema-bearing tools.`,
      );
    }
    const taskSupport = tool.execution?.taskSupport;
    if (taskSupport === "required" || taskSupport === "optional") {
      throw new Error(
        `installEnvelopeValidator: tool "${name}" has taskSupport="${taskSupport}", but the envelope validator does not replicate the SDK's task-handler branches. Mirror them from @modelcontextprotocol/sdk/server/mcp.js:109-122 before adding task-aware tools.`,
      );
    }
  }

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const hasArguments = Object.hasOwn(request.params, "arguments");
    const args = hasArguments ? request.params.arguments : {};

    const tool = registry[name];
    if (!tool) {
      return envelopeError("not_found", `Tool ${name} not found`);
    }
    if (tool.enabled === false) {
      return envelopeError("validation_error", `Tool ${name} is disabled`);
    }

    let parsedArgs: unknown = args;
    if (tool.inputSchema !== undefined) {
      const inputObj = normalizeObjectSchema(tool.inputSchema as never);
      const schemaToParse = inputObj ?? (tool.inputSchema as never);
      const parseResult = await safeParseAsync(schemaToParse, args);
      if (!parseResult.success) {
        const errObj = (parseResult as { error?: { issues?: unknown } }).error;
        const issues = Array.isArray(errObj?.issues) ? errObj.issues : [];
        const err = new InvalidArgumentsError(
          `Invalid arguments for tool ${name}`,
          issues,
          "see `issues` for per-field detail (path + zod issue code + expected vs received)",
        );
        return {
          content: [{ type: "text", text: formatToolError(err) }],
          isError: true,
        };
      }
      parsedArgs = parseResult.data;

      const unrecognized = findStrippedKeys(args, parsedArgs);
      if (unrecognized.length > 0) {
        const keysList = unrecognized.map((entry) => `"${entry.path.join(".")}"`).join(", ");
        const err = new InvalidArgumentsError(
          `Invalid arguments for tool ${name}: unrecognized ${unrecognized.length > 1 ? "keys" : "key"} ${keysList}`,
          [
            {
              code: "unrecognized_keys",
              keys: unrecognized.map((entry) => entry.key),
              path: unrecognized[0]?.path.slice(0, -1) ?? [],
              message: `Unrecognized ${unrecognized.length > 1 ? "keys" : "key"}: ${keysList}`,
            },
          ],
          "remove the listed keys (they're not in the tool's input schema). Check for typos / wrong singular-vs-plural.",
        );
        return {
          content: [{ type: "text", text: formatToolError(err) }],
          isError: true,
        };
      }
    }

    try {
      return await tool.handler(parsedArgs, extra);
    } catch (err) {
      return {
        content: [{ type: "text", text: formatToolError(err) }],
        isError: true,
      };
    }
  });
}

function findStrippedKeys(
  original: unknown,
  parsed: unknown,
  path: Array<string | number> = [],
): Array<{ key: string; path: Array<string | number> }> {
  if (!isPlainObject(original) || !isPlainObject(parsed)) {
    if (Array.isArray(original) && Array.isArray(parsed)) {
      return original.flatMap((item, i) => findStrippedKeys(item, parsed[i], [...path, i]));
    }
    return [];
  }
  const parsedKeys = new Set(Object.keys(parsed));
  const stripped = Object.keys(original)
    .filter((key) => !parsedKeys.has(key))
    .map((key) => ({ key, path: [...path, key] }));
  const nested = Object.keys(original)
    .filter((key) => parsedKeys.has(key))
    .flatMap((key) =>
      findStrippedKeys(
        (original as Record<string, unknown>)[key],
        (parsed as Record<string, unknown>)[key],
        [...path, key],
      ),
    );
  return [...stripped, ...nested];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
