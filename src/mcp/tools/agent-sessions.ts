import { envelope } from "../../lib/envelope.ts";
import {
  type AgentSessionListMcpInput,
  agentSessionGetOperation,
  agentSessionListOperation,
  agentSessionListPayload,
  buildAgentSessionGetInput,
  buildAgentSessionGetMcpInputSchema,
  buildAgentSessionListInputFromMcp,
  buildAgentSessionListMcpInputSchema,
  executeAgentSessionGet,
  executeAgentSessionList,
} from "../../surface/agent-sessions.ts";
import { text } from "../response.ts";
import type { McpToolSpec, ToolHandlerArgs } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface AgentSessionToolDeps {
  workspaceParamDescription: string;
  /** Kept for server wiring compatibility; get path throws via surface execute. */
  requireMcpEntity: <T>(value: T | null | undefined, label: string, id: string, hint?: string) => T;
}

const AGENT_SESSION_GET_NOT_FOUND_HINT =
  "verify the agent session UUID; run list_agent_sessions to discover ids";

export function buildAgentSessionsToolSpecs(deps: AgentSessionToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_agent_sessions",
      config: mcpToolConfig(
        agentSessionListOperation,
        buildAgentSessionListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: AgentSessionListMcpInput) => {
        const result = await executeAgentSessionList(buildAgentSessionListInputFromMcp(args));
        return text(envelope(agentSessionListPayload(result)));
      },
    },
    {
      name: "get_agent_session",
      config: mcpToolConfig(
        agentSessionGetOperation,
        buildAgentSessionGetMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ToolHandlerArgs) => {
        const session = await executeAgentSessionGet(
          buildAgentSessionGetInput(args.id as string),
          AGENT_SESSION_GET_NOT_FOUND_HINT,
        );
        return text(envelope({ agent_session: session }));
      },
    },
  ];
}
