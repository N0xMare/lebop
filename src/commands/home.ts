/**
 * Content-first bare `lebop` home — agent-only dense control plane (AXI §8).
 * Always emits machine output (TOON by default). No human chalk catalog.
 */

import { repoCacheDir } from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import { listIssuesWithMetadata } from "../lib/listIssues.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import { resolveWorkspaceSlugForState, workspaceCacheRoot } from "../lib/paths.ts";
import { LEBOP_VERSION } from "../lib/version.ts";

export async function runHome(opts: {
  json?: boolean;
  format?: string;
  pretty?: boolean;
  /** Skip Linear list (catalog/orient without API cost). */
  offline?: boolean;
}): Promise<void> {
  const bin = process.argv[1] ?? "lebop";
  const binDisplay = bin.replace(process.env.HOME ?? "", "~");
  const workspace = resolveWorkspaceSlugForState();
  let team = "_unset";
  let repoHash = "_global";
  let issues: { id: string; t: string; st: string | null }[] = [];
  let note: string | undefined;

  if (!opts.offline) {
    try {
      const config = await resolveConfig();
      team = config.team;
      repoHash = config.repoHash;
      const listed = await listIssuesWithMetadata({
        resolvedTeam: config.team,
        assignee: "me",
        stateTypeIn: ["triage", "backlog", "unstarted", "started"],
        max: 8,
      });
      issues = listed.issues.map((i) => ({
        id: i.identifier,
        t: i.title,
        st: i.state,
      }));
    } catch (err) {
      note = (err as Error).message;
    }
  }

  const cache = repoCacheDir(repoHash, workspace);
  const payload: Record<string, unknown> = {
    v: LEBOP_VERSION,
    bin: binDisplay,
    what: "Linear I/O for agents (CLI+MCP)",
    ws: workspace,
    team,
    cache,
    wsc: workspaceCacheRoot(workspace),
    mine_n: issues.length,
    ...(issues.length
      ? {
          mine: issues,
        }
      : {}),
    ...(note ? { note } : {}),
    next: ["help", "list --assignee me", "workspace explore /", 'search --query "…"'],
  };

  // Agent product: always machine (TOON default). --pretty / --format override.
  writeMachineEnvelope(payload, {
    json: true,
    format: opts.format ?? process.env.LEBOP_MACHINE_FORMAT,
    pretty: opts.pretty,
  });
}
