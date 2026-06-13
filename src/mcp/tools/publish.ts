import { envelope } from "../../lib/envelope.ts";
import {
  buildPublishApplyInputFromMcp,
  buildPublishApplyMcpInputSchema,
  buildPublishReviewInputFromMcp,
  buildPublishReviewMcpInputSchema,
  executePublishApply,
  executePublishReview,
  type PublishApplyMcpInput,
  type PublishReviewMcpInput,
  publishApplyOperation,
  publishReviewOperation,
} from "../../surface/publish.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface PublishToolDeps {
  workspaceParamDescription: string;
}

export function buildPublishToolSpecs(deps: PublishToolDeps): McpToolSpec[] {
  return [
    {
      name: "review_linear_changes",
      config: mcpToolConfig(
        publishReviewOperation,
        buildPublishReviewMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: PublishReviewMcpInput) =>
        text(envelope({ ...(await executePublishReview(buildPublishReviewInputFromMcp(args))) })),
    },
    {
      name: "publish_linear_changes",
      config: mcpToolConfig(
        publishApplyOperation,
        buildPublishApplyMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: PublishApplyMcpInput) =>
        text(envelope({ ...(await executePublishApply(buildPublishApplyInputFromMcp(args))) })),
    },
  ];
}
