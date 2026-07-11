import { envelope } from "../../lib/envelope.ts";
import {
  buildLookupStateByNameInputFromMcp,
  buildLookupStateByNameMcpInputSchema,
  buildLookupUserByEmailInputFromMcp,
  buildLookupUserByEmailMcpInputSchema,
  executeLookupStateByName,
  executeLookupUserByEmail,
  type LookupStateByNameMcpInput,
  type LookupUserByEmailMcpInput,
  lookupStateByNameOperation,
  lookupStateByNamePayload,
  lookupUserByEmailOperation,
  lookupUserByEmailPayload,
} from "../../surface/lookups.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface LookupToolDeps {
  workspaceParamDescription: string;
}

export function buildLookupToolSpecs(deps: LookupToolDeps): McpToolSpec[] {
  return [
    {
      name: "lookup_state_by_name",
      config: mcpToolConfig(
        lookupStateByNameOperation,
        buildLookupStateByNameMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: LookupStateByNameMcpInput) => {
        const result = await executeLookupStateByName(buildLookupStateByNameInputFromMcp(args));
        return text(envelope(lookupStateByNamePayload(result)));
      },
    },
    {
      name: "lookup_user_by_email",
      config: mcpToolConfig(
        lookupUserByEmailOperation,
        buildLookupUserByEmailMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: LookupUserByEmailMcpInput) => {
        const result = await executeLookupUserByEmail(buildLookupUserByEmailInputFromMcp(args));
        return text(envelope(lookupUserByEmailPayload(result)));
      },
    },
  ];
}
