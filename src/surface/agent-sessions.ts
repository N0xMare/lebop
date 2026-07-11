import { z } from "zod";
import {
  getAgentSession,
  type ListedAgentSession,
  listAgentSessions,
} from "../lib/agentSessions.ts";
import { parseCliLimit } from "../lib/cliOptions.ts";
import { NotFoundError } from "../lib/errors.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

export interface AgentSessionListInput {
  status?: string;
  issueId?: string;
  max: number;
}

export interface AgentSessionListCliInput {
  opts: {
    status?: string;
    issueId?: string;
    limit?: string;
  };
}

export type AgentSessionListMcpInput = Record<string, unknown> & {
  status?: string;
  issue_id?: string;
  limit?: number;
};

export interface AgentSessionGetInput {
  id: string;
}

export interface AgentSessionListExecutionResult {
  count: number;
  agent_sessions: ListedAgentSession[];
}

const agentSessionListCanonicalSchema = z
  .object({
    status: z.string().optional(),
    issueId: z.string().optional(),
    max: z.union([z.number(), z.literal(Number.POSITIVE_INFINITY)]),
  })
  .strict();

const agentSessionGetCanonicalSchema = z.object({ id: z.string() }).strict();

export function buildAgentSessionListInputFromCli(
  input: AgentSessionListCliInput,
): AgentSessionListInput {
  return parseSurfaceInput("agent_sessions.list", agentSessionListCanonicalSchema, {
    status: input.opts.status,
    issueId: input.opts.issueId,
    max: parseCliLimit(input.opts.limit, { defaultValue: 50, zeroMeansInfinity: true }),
  });
}

export function buildAgentSessionListInputFromMcp(
  input: AgentSessionListMcpInput,
): AgentSessionListInput {
  const limit = input.limit ?? 50;
  return parseSurfaceInput("agent_sessions.list", agentSessionListCanonicalSchema, {
    status: input.status,
    issueId: input.issue_id,
    max: limit === 0 ? Number.POSITIVE_INFINITY : limit,
  });
}

export function buildAgentSessionGetInput(id: string): AgentSessionGetInput {
  return parseSurfaceInput("agent_sessions.get", agentSessionGetCanonicalSchema, { id });
}

export async function executeAgentSessionList(
  input: AgentSessionListInput,
): Promise<AgentSessionListExecutionResult> {
  const sessions = await listAgentSessions({
    status: input.status,
    issueId: input.issueId,
    max: input.max,
  });
  return {
    count: sessions.length,
    agent_sessions: sessions,
  };
}

export function agentSessionListPayload(result: AgentSessionListExecutionResult) {
  return {
    count: result.count,
    agent_sessions: result.agent_sessions,
  };
}

export async function executeAgentSessionGet(
  input: AgentSessionGetInput,
  notFoundHint?: string,
): Promise<ListedAgentSession> {
  const session = await getAgentSession(input.id);
  if (!session) {
    throw new NotFoundError(`agent session not found: ${input.id}`, notFoundHint);
  }
  return session;
}

export function buildAgentSessionListMcpInputSchema(workspaceDescription: string) {
  return {
    status: z.string().optional(),
    issue_id: z.string().optional().describe("Issue UUID."),
    limit: z.number().int().min(0).optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildAgentSessionGetMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export const agentSessionListOperation = {
  id: "agent_sessions.list",
  domain: "agent_sessions",
  resource: "agent_session",
  action: "list",
  title: "List Linear agent sessions",
  description: "Read-only. Filter by status or scope to one issue.",
  cli: { command: "agent-session list", liveSteps: ["cli:agent-session list --json"] },
  mcp: {
    tool: "list_agent_sessions",
    title: "List Linear agent sessions",
    description: "Read-only. Filter by status or scope to one issue.",
    annotations: {
      title: "List Linear agent sessions",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildAgentSessionListInputFromCli,
  fromMcp: buildAgentSessionListInputFromMcp,
} satisfies SurfaceOperationContract<
  AgentSessionListInput,
  AgentSessionListExecutionResult,
  AgentSessionListCliInput,
  AgentSessionListMcpInput
>;

export const agentSessionGetOperation = {
  id: "agent_sessions.get",
  domain: "agent_sessions",
  resource: "agent_session",
  action: "get",
  title: "Get one agent session by UUID",
  description:
    "Returns one agent session. Missing ids surface as structured not_found errors, matching `lebop agent-session view --json`.",
  cli: { command: "agent-session view", liveSteps: ["cli:agent-session view --json"] },
  mcp: {
    tool: "get_agent_session",
    title: "Get one agent session by UUID",
    description:
      "Returns one agent session. Missing ids surface as structured not_found errors, matching `lebop agent-session view --json`.",
    annotations: {
      title: "Get one agent session by UUID",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
} satisfies SurfaceOperationContract<AgentSessionGetInput, ListedAgentSession>;

export const AGENT_SESSION_SURFACE_OPERATIONS = [
  agentSessionListOperation,
  agentSessionGetOperation,
] as const;
