import { envelope } from "../../lib/envelope.ts";
import {
  buildLintFilesInputFromMcp,
  buildLintFilesMcpInputSchema,
  buildLintTextInputFromMcp,
  buildLintTextMcpInputSchema,
  executeLintFiles,
  executeLintText,
  type LintFilesMcpInput,
  type LintTextMcpInput,
  lintFilesMcpPayload,
  lintFilesOperation,
  lintTextOperation,
  lintTextPayload,
} from "../../surface/lint.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface LintToolDeps {
  workspaceParamDescription: string;
}

export function buildLintToolSpecs(deps: LintToolDeps): McpToolSpec[] {
  return [
    {
      name: "lint_files",
      config: mcpToolConfig(
        lintFilesOperation,
        buildLintFilesMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: LintFilesMcpInput) => {
        const result = await executeLintFiles(buildLintFilesInputFromMcp(args));
        return text(envelope(lintFilesMcpPayload(result)));
      },
    },
    {
      name: "lint_text",
      config: mcpToolConfig(lintTextOperation, buildLintTextMcpInputSchema()),
      handler: async (args: LintTextMcpInput) => {
        const result = executeLintText(buildLintTextInputFromMcp(args));
        return text(envelope({ ...lintTextPayload(result) }));
      },
    },
  ];
}
