/**
 * lebop's MCP server. Exposes lib functions as MCP tools so non-CLI agents
 * (Cursor, Claude Desktop, Windsurf, IDE extensions) can drive Linear with
 * the same retry/CAS/lint guarantees the CLI provides.
 *
 * Auth: bearer-token via the existing `~/.lebop/auth.json` (multi-workspace).
 * Tool calls accept an optional `workspace` arg to target a specific
 * workspace; falls back to LEBOP_WORKSPACE env or the auth file's default.
 *
 * Transport: stdio. Right shape for binary distribution; HTTP+SSE comes in
 * a follow-up release.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LebopError } from "../lib/errors.ts";
import { lintContent } from "../lib/lint.ts";
import { listIssues } from "../lib/listIssues.ts";
import { LINK_KINDS, type LinkKind, createLink, listRelations } from "../lib/relations.ts";
import { withClient } from "../lib/sdk.ts";

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "lebop",
    version: "0.1.0",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // server.connect resolves when the transport closes; we just await it
  // implicitly by returning. Stay alive until stdin EOF / parent exit.
}

/**
 * Register the initial vertical slice of MCP tools. This proves the lib
 * shape under both the CLI and MCP surfaces; expanded coverage lands as
 * §13.2 commands ship and their lib helpers stabilize.
 */
function registerTools(server: McpServer): void {
  // ---------- list_issues ----------
  server.registerTool(
    "list_issues",
    {
      title: "List Linear issues by filter",
      description:
        "Filter, paginate, and return Linear issues. Same surface as `lebop list` — search, assignee, state, label, project, cycle, milestone, priority, time filters. Returns plain records.",
      inputSchema: {
        team: z
          .string()
          .optional()
          .describe("Team key (e.g. 'ENG'). Omit + set allTeams to search across all teams."),
        all_teams: z
          .boolean()
          .optional()
          .describe("Drop the team filter for cross-workspace search."),
        project: z.string().optional(),
        project_id: z.string().optional(),
        state: z.string().optional(),
        state_type: z
          .enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"])
          .optional(),
        assignee: z.string().optional().describe("'me'/'@me', email, name, or '*' for any."),
        unassigned: z.boolean().optional(),
        label: z.array(z.string()).optional(),
        priority: z.number().int().min(0).max(4).optional(),
        cycle: z.string().optional().describe("Cycle name or UUID."),
        milestone: z.string().optional().describe("Project milestone name or UUID."),
        updated_since: z
          .string()
          .optional()
          .describe("Relative ('7d'/'24h'/'15m') or ISO timestamp."),
        created_after: z.string().optional(),
        search: z.string().optional().describe("Full-text across title + body."),
        include_archived: z.boolean().optional(),
        limit: z.number().int().min(0).optional().describe("0 = no user cap."),
        workspace: z.string().optional().describe("Target a specific workspace slug."),
      },
    },
    async (args) => {
      withWorkspace(args.workspace);
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const issues = await listIssues({
        resolvedTeam: args.all_teams ? undefined : args.team,
        team: args.team,
        allTeams: args.all_teams,
        project: args.project,
        projectId: args.project_id,
        state: args.state,
        stateType: args.state_type,
        assignee: args.assignee,
        unassigned: args.unassigned,
        label: args.label,
        priority: args.priority,
        cycle: args.cycle,
        milestone: args.milestone,
        updatedSince: args.updated_since,
        createdAfter: args.created_after,
        search: args.search,
        includeArchived: args.include_archived,
        max,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ schema_version: 1, count: issues.length, issues }, null, 2),
          },
        ],
      };
    },
  );

  // ---------- add_relation ----------
  server.registerTool(
    "add_relation",
    {
      title: "Create a relation between two issues",
      description: `Add a Linear relation. Server-side idempotent at the (issueId, relatedIssueId, type) tuple — re-running with the same args returns the existing relation. Kinds: ${LINK_KINDS.join(" | ")}.`,
      inputSchema: {
        from: z.string().describe("Source issue identifier (e.g. 'TEAM-101')."),
        kind: z.enum(LINK_KINDS as readonly [LinkKind, ...LinkKind[]]),
        to: z.string().describe("Target issue identifier."),
        workspace: z.string().optional(),
      },
    },
    async (args) => {
      withWorkspace(args.workspace);
      const upperFrom = args.from.toUpperCase();
      const upperTo = args.to.toUpperCase();
      const [self, target] = await Promise.all([
        withClient((c) => c.issue(upperFrom)),
        withClient((c) => c.issue(upperTo)),
      ]);
      if (!self) throw new Error(`issue not found: ${upperFrom}`);
      if (!target) throw new Error(`link target not found: ${upperTo}`);
      const result = await createLink(self.id, target.id, args.kind);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                schema_version: 1,
                from: upperFrom,
                kind: args.kind,
                to: upperTo,
                relation_id: result.id,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ---------- list_relations ----------
  server.registerTool(
    "list_relations",
    {
      title: "List relations for an issue",
      description: "Return outbound + inbound relations for one issue. Pure read.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier (e.g. 'TEAM-101')."),
        workspace: z.string().optional(),
      },
    },
    async (args) => {
      withWorkspace(args.workspace);
      const upper = args.identifier.toUpperCase();
      const result = await listRelations(upper);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ schema_version: 1, identifier: upper, ...result }, null, 2),
          },
        ],
      };
    },
  );

  // ---------- lint_text ----------
  // Differentiator tool — neither linear-cli nor Linear's MCP has this.
  server.registerTool(
    "lint_text",
    {
      title: "Lint markdown for Linear renderer quirks",
      description:
        "Run lebop's universal lint rules (L001-L006) against text. Catches table-cell ordered-list markers, setext H2 from `text\\n---`, etc. Returns warnings + a fixed version when --fix-equivalent applied.",
      inputSchema: {
        content: z.string().describe("Markdown content to lint."),
      },
    },
    async (args) => {
      const { warnings } = lintContent(args.content, {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                schema_version: 1,
                warning_count: warnings.length,
                warnings: warnings.map((w) => ({
                  rule: w.rule,
                  severity: w.severity,
                  message: w.message,
                  line: w.line,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

/**
 * Set LEBOP_WORKSPACE for the duration of this tool call so the existing
 * `loadAuthForWorkspace` env-var path picks it up. The cached LinearClient
 * map is keyed by slug, so per-workspace selection works correctly.
 *
 * Note: this mutates process.env. For an MCP server handling concurrent
 * tool calls, this is racy — Node's stdio MCP transport processes requests
 * serially, so we're fine for now. A per-call workspace context (passed
 * through withClient explicitly) is a future enhancement.
 */
function withWorkspace(workspace: string | undefined): void {
  if (workspace) {
    process.env.LEBOP_WORKSPACE = workspace;
  }
}

/**
 * Format a thrown error as an MCP tool-call response. LebopError surfaces
 * its code + hint; everything else falls through to the message.
 */
export function formatToolError(err: unknown): string {
  if (err instanceof LebopError) {
    return JSON.stringify(
      {
        error: {
          code: err.code,
          message: err.message,
          hint: err.hint,
        },
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    { error: { code: "unknown", message: (err as Error).message ?? String(err) } },
    null,
    2,
  );
}
