import type { McpServer, RegisteredTool, ToolCallback } from "@modelcontextprotocol/server";
import { z } from "zod";
import { InvalidArgumentsError } from "../lib/errors.ts";
import { envelopeError, formatToolError } from "./response.ts";

export function installEnvelopeValidator(
  server: McpServer,
  tools: ReadonlyMap<string, RegisteredTool>,
): void {
  for (const [name, tool] of tools) {
    if (tool.outputSchema !== undefined) {
      throw new Error(
        `installEnvelopeValidator: tool "${name}" has an outputSchema, but the envelope validator does not replicate the SDK's output-validation branch. Add output validation before adding outputSchema-bearing tools.`,
      );
    }
    const taskSupport = tool.execution?.taskSupport;
    if (taskSupport === "required" || taskSupport === "optional") {
      throw new Error(
        `installEnvelopeValidator: tool "${name}" has taskSupport="${taskSupport}", but the envelope validator does not support task-aware tools.`,
      );
    }
  }

  server.server.setRequestHandler("tools/call", async (request, extra) => {
    const name = request.params.name;
    const hasArguments = Object.hasOwn(request.params, "arguments");
    const args = hasArguments ? request.params.arguments : {};

    const tool = tools.get(name);
    if (!tool) {
      return envelopeError("not_found", `Tool ${name} not found`);
    }
    if (tool.enabled === false) {
      return envelopeError("validation_error", `Tool ${name} is disabled`);
    }

    let parsedArgs: unknown = args;
    if (tool.inputSchema !== undefined) {
      // startMcpServer registers Zod objects; parse with Zod directly to retain
      // issue codes and paths in lebop's structured invalid_arguments envelope.
      const parseResult = await z.safeParseAsync(tool.inputSchema as z.ZodType, args);
      if (!parseResult.success) {
        const err = new InvalidArgumentsError(
          `Invalid arguments for tool ${name}`,
          parseResult.error.issues,
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
      const handler = tool.handler as ToolCallback<z.ZodType>;
      return await handler(parsedArgs, extra);
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
