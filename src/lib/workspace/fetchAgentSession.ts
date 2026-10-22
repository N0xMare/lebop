/**
 * Mechanical extract from workspaceFetch — kind context.
 */

import { getAgentSession } from "../agentSessions.ts";
import { NotFoundError } from "../errors.ts";
import { type ContextFile, writeWorkspaceContext } from "../workspaceContextWriter.ts";
import type { ExploreCursor } from "../workspaceExplore.ts";
import { safeSegment } from "../workspacePaths.ts";
import {
  markComplete,
  recommendedList,
  recommendedReads,
  renderEntityMarkdown,
} from "./fetchShared.ts";
import type {
  FetchCompletenessEntry,
  FetchLinearWorkspaceResult,
  FetchSelection,
} from "./fetchTypes.ts";

export async function fetchAgentSessionContext(input: {
  target: string;
  sessionId: string;
  config: { repoHash: string };
  selection: FetchSelection;
  to?: string;
  cursor: ExploreCursor | null;
}): Promise<FetchLinearWorkspaceResult> {
  const session = await getAgentSession(input.sessionId);
  if (!session)
    throw new NotFoundError(
      `agent session not found: ${input.sessionId}`,
      "verify the agent session UUID",
    );

  const files: ContextFile[] = [
    {
      relative: `agent-sessions/${safeSegment(session.id)}/agent-session.md`,
      content: renderEntityMarkdown("Agent session", session.id, session),
    },
  ];
  const counts: Record<string, number> = { agent_sessions: 1 };
  const completeness: Record<string, FetchCompletenessEntry> = {};
  markComplete(completeness, "agent_sessions", 1);
  const summary = {
    target: input.target,
    kind: "agent_session",
    ...input.selection,
    agent_session: session,
    counts,
    completeness,
    omitted: [],
    truncated: false,
    continuations: [],
  };
  const reads = recommendedReads([`agent-sessions/${safeSegment(session.id)}/agent-session.md`]);
  const index = [
    `# Linear agent session context: ${session.id}`,
    "",
    `Target: ${input.target}`,
    session.issue ? `Issue: ${session.issue.identifier}` : null,
    session.status ? `Status: ${session.status}` : null,
    "",
    "## Recommended files",
    "",
    ...recommendedList(reads),
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  const written = await writeWorkspaceContext({
    repoHash: input.config.repoHash,
    target: session.id,
    kind: "agent_session",
    index,
    summary,
    manifest: summary,
    files,
    recommendedReads: reads,
    to: input.to,
  });

  return {
    target: input.target,
    kind: "agent_session",
    ...input.selection,
    counts,
    completeness,
    omitted: [],
    truncated: false,
    continuations: [],
    ...written,
  };
}
