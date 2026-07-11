import { envelope } from "../../lib/envelope.ts";
import {
  buildLinkUrlInputFromMcp,
  buildLinkUrlMcpInputSchema,
  executeLinkUrl,
  type LinkUrlMcpInput,
  linkUrlMcpPayload,
  linkUrlOperation,
} from "../../surface/link.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface LinkToolDeps {
  workspaceParamDescription: string;
}

export function buildLinkToolSpecs(deps: LinkToolDeps): McpToolSpec[] {
  return [
    {
      name: "link_url_to_issue",
      config: mcpToolConfig(
        linkUrlOperation,
        buildLinkUrlMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: LinkUrlMcpInput) => {
        const result = await executeLinkUrl(buildLinkUrlInputFromMcp(args));
        return text(envelope(linkUrlMcpPayload(result)));
      },
    },
  ];
}
