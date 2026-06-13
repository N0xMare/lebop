import { runWithRequestContext } from "../lib/requestContext.ts";
import { formatToolError } from "./response.ts";
import type {
  McpRegistrar,
  McpServerLike,
  McpToolSpec,
  ToolHandlerArgs,
  ToolHandlerResult,
} from "./types.ts";

export function safe<A extends ToolHandlerArgs>(
  fn: (args: A) => Promise<ToolHandlerResult>,
): (args: A) => Promise<ToolHandlerResult> {
  return async (args) => {
    return runWithRequestContext({ workspace: args.workspace as string | undefined }, async () => {
      try {
        return await fn(args);
      } catch (err) {
        return {
          content: [{ type: "text", text: formatToolError(err) }],
          isError: true,
        };
      }
    });
  };
}

export function registerMcpToolSpecs(
  registrar: McpServerLike,
  specs: readonly McpToolSpec[],
): void {
  const target = registrar as McpRegistrar;
  for (const spec of specs) {
    target.registerTool(spec.name, spec.config, safe(spec.handler));
  }
}
