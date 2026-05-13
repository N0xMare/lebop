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
import {
  normalizeObjectSchema,
  safeParseAsync,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { getAgentSession, listAgentSessions } from "../lib/agentSessions.ts";
import { deleteAttachment, listAttachments, updateAttachment } from "../lib/attachments.ts";
import { loadAuth, loadAuthForWorkspace, setDefaultWorkspace, validateToken } from "../lib/auth.ts";
import { buildComments, buildIssueMetadata } from "../lib/build.ts";
import { bulkUpdateIssues } from "../lib/bulk.ts";
import {
  gcCache,
  type IssueMetadata,
  issueDir,
  listCachedIssues,
  listCachedProjectIds,
  type ProjectMetadata,
  readIssue,
  readProject,
  writeComment,
  writeIssue,
} from "../lib/cache.ts";
import { addComment, deleteComment, listComments, updateComment } from "../lib/comments.ts";
import { resolveConfig } from "../lib/config.ts";
import { setWorkspaceDefaultTeam } from "../lib/configWrite.ts";
import { getCycle, listCycles } from "../lib/cycles.ts";
import { arraysEqual, diffIssueMetadata, diffProjectMetadata } from "../lib/diff.ts";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from "../lib/documents.ts";
import { envelope, SCHEMA_VERSION } from "../lib/envelope.ts";
import {
  InvalidArgumentsError,
  LebopError,
  NotFoundError,
  tryIdempotentDelete,
  ValidationError,
} from "../lib/errors.ts";
import {
  archiveInitiative,
  createInitiative,
  createInitiativeUpdate,
  deleteInitiative,
  getInitiative,
  type InitiativeHealth,
  initiativeAddProject,
  initiativeRemoveProject,
  listInitiatives,
  listInitiativeUpdates,
  resolveInitiativeId,
  unarchiveInitiative,
  updateInitiative,
} from "../lib/initiatives.ts";
import {
  archiveIssues,
  createIssue,
  getIssue,
  unarchiveIssues,
  updateIssue,
} from "../lib/issues.ts";
import { createLabel, deleteLabel, listLabels, resolveLabelByName } from "../lib/labels.ts";
import { lintContent } from "../lib/lint.ts";
import { listIssues } from "../lib/listIssues.ts";
import { lookupStateByName, lookupUserByEmail } from "../lib/lookups.ts";
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  listMilestones,
  resolveProjectId,
  updateMilestone,
} from "../lib/milestones.ts";
import { paginateRaw } from "../lib/paginate.ts";
import { applyPlan } from "../lib/planApply.ts";
import { diffPlan } from "../lib/planDiff.ts";
import { parsePlan } from "../lib/planParse.ts";
import { pullPlan } from "../lib/planPull.ts";
import { validatePlan } from "../lib/planValidate.ts";
import {
  createProject,
  createProjectUpdate,
  deleteProject,
  getProject,
  listProjects,
  listProjectUpdates,
  type ProjectHealth,
  updateProject,
} from "../lib/projects.ts";
import { buildPullIssuesQuery, type FetchedIssue } from "../lib/pullQuery.ts";
import { buildIssueUpdateInput } from "../lib/pushBuild.ts";
import { buildCasQuery, ISSUE_UPDATE_MUTATION } from "../lib/pushMutations.ts";
import { createLink, LINK_KINDS, type LinkKind, listRelations } from "../lib/relations.ts";
import { deriveTeamFromIdentifiers, getTeamMetadata } from "../lib/resolve.ts";
import { withClient } from "../lib/sdk.ts";
import { listTeamMembers } from "../lib/teamMembers.ts";
import { getTeam } from "../lib/teams.ts";
import { listWorkflowStates } from "../lib/workflowStates.ts";

// resolveMilestoneIdByName / resolveCycleIdByName moved to ../lib/resolve.ts
// in wave 3 — both updateIssue (lib) and update_issue (MCP) now share the
// same implementations. The cycle resolver gained a required `teamKey`
// scoping parameter to fix the pick-first-cross-team-match bug the wave-2
// reviewer flagged.

// Canonical description for the `workspace` param shared across all tools.
// Centralizing here lets agents memorize the precedence once instead of per-tool.
const WORKSPACE_PARAM_DESCRIPTION =
  "Target Linear workspace slug. Precedence: this param > LEBOP_WORKSPACE env > auth file default. Omit to use the default.";

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "lebop",
    version: "0.0.2",
  });

  registerTools(server);
  installEnvelopeValidator(server);

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
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List Linear issues by filter",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      // Round-6 / A11: validate team existence at the boundary so unknown
      // team keys surface as `code: not_found` instead of silently filtering
      // to empty `count: 0`. Matches the loud behavior of `list_projects`
      // and `list_team_members`. Skipped when `all_teams: true`.
      if (!args.all_teams && args.team) {
        const t = await getTeam(args.team as string);
        if (!t) {
          throw new NotFoundError(
            `team not found: ${args.team}`,
            "use `lebop teams` (or the `list_workspaces` MCP tool) to see available team keys",
          );
        }
      }
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
            text: JSON.stringify(envelope({ count: issues.length, issues }), null, 2),
          },
        ],
      };
    }),
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
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create a relation between two issues",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const upperFrom = args.from.toUpperCase();
      const upperTo = args.to.toUpperCase();
      const [self, target] = await Promise.all([
        withClient((c) => c.issue(upperFrom)),
        withClient((c) => c.issue(upperTo)),
      ]);
      if (!self)
        throw new NotFoundError(
          `issue not found: ${upperFrom}`,
          `verify ${upperFrom} exists and is visible to your token`,
        );
      if (!target)
        throw new NotFoundError(
          `link target not found: ${upperTo}`,
          `verify ${upperTo} exists and is visible to your token`,
        );
      const result = await createLink(self.id, target.id, args.kind);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope({
                from: upperFrom,
                kind: args.kind,
                to: upperTo,
                relation_id: result.id,
              }),
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // ---------- list_relations ----------
  server.registerTool(
    "list_relations",
    {
      title: "List relations for an issue",
      description: "Return outbound + inbound relations for one issue. Pure read.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier (e.g. 'TEAM-101')."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List relations for an issue",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const upper = args.identifier.toUpperCase();
      const result = await listRelations(upper);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(envelope({ identifier: upper, ...result }), null, 2),
          },
        ],
      };
    }),
  );

  // ---------- labels ----------
  server.registerTool(
    "list_labels",
    {
      title: "List Linear labels",
      description: "List labels in a team, workspace-only, or all visible.",
      inputSchema: {
        team: z
          .string()
          .optional()
          .describe("Team key. Omit + workspace_only=true for workspace labels."),
        workspace_only: z.boolean().optional(),
        all: z.boolean().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List Linear labels",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      // Round-6 / A11: same team-existence pre-check as list_issues. When
      // a `team` arg is passed without `workspace_only`/`all`, validate it
      // exists so callers get `code: not_found` instead of `count: <random>`
      // (labels are partially workspace-scoped, so a bad team key silently
      // returned the workspace-wide labels — confusing).
      if (!args.workspace_only && !args.all && args.team) {
        const t = await getTeam(args.team as string);
        if (!t) {
          throw new NotFoundError(
            `team not found: ${args.team}`,
            "use `lebop teams` to see available team keys; or pass `workspace_only: true` to skip team scoping",
          );
        }
      }
      const labels = await listLabels({
        team: args.workspace_only || args.all ? undefined : args.team,
        workspaceOnly: args.workspace_only,
        all: args.all,
      });
      return text(envelope({ count: labels.length, labels }));
    }),
  );

  server.registerTool(
    "create_label",
    {
      title: "Create a Linear label",
      description:
        'Create a team-scoped or workspace-scoped label. Pass `scope: "team"` with `team_id` for a team label, or `scope: "workspace"` (with no team_id) for a workspace-wide label. NOT retry-wrapped (would duplicate).',
      inputSchema: {
        name: z.string(),
        scope: z
          .enum(["team", "workspace"])
          .optional()
          .describe(
            "Discriminator: 'team' requires team_id; 'workspace' forbids team_id. Backward-compat: if omitted, presence of team_id selects 'team', absence selects 'workspace'.",
          ),
        team_id: z.string().optional().describe("Team UUID (NOT key). Required when scope='team'."),
        color: z.string().optional().describe("Hex color (e.g. '#ff0000')."),
        description: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create a Linear label",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      // Cross-field validation for scope discriminator. Defaults preserve
      // pre-wave-2 behavior so existing callers don't break: team_id present
      // → team; otherwise workspace. New callers should pass scope explicitly.
      const scope: "team" | "workspace" =
        (args.scope as "team" | "workspace" | undefined) ?? (args.team_id ? "team" : "workspace");
      if (scope === "team" && !args.team_id) {
        throw new ValidationError(
          "scope='team' requires team_id",
          "pass a team UUID via team_id, or set scope='workspace' for a workspace-wide label",
        );
      }
      if (scope === "workspace" && args.team_id) {
        throw new ValidationError(
          "scope='workspace' forbids team_id",
          "drop team_id, or set scope='team' to scope the label to that team",
        );
      }
      const label = await createLabel({
        name: args.name,
        teamId: scope === "team" ? (args.team_id as string) : undefined,
        color: args.color,
        description: args.description,
      });
      return text(envelope({ label }));
    }),
  );

  server.registerTool(
    "delete_label",
    {
      title: "Delete a Linear label",
      description:
        "Delete by UUID. Idempotent — re-deleting an already-absent label returns `{status: 'already-absent'}` without error. Round-7 / Q2.",
      inputSchema: {
        id: z
          .string()
          .describe("Label UUID. Use lookup_label_by_name first if you only have the name."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete a Linear label",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { status } = await tryIdempotentDelete(() => deleteLabel(args.id));
      return text(envelope({ id: args.id, status, success: status === "deleted" }));
    }),
  );

  server.registerTool(
    "lookup_label_by_name",
    {
      title: "Resolve a label name to a UUID",
      description: "Returns the matching label or null. Useful before delete_label.",
      inputSchema: {
        name: z.string(),
        team: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Resolve a label name to a UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const label = await resolveLabelByName(args.name, args.team);
      return text(envelope({ label }));
    }),
  );

  // ---------- milestones ----------
  server.registerTool(
    "list_milestones",
    {
      title: "List project milestones",
      description:
        "List milestones; pass project to filter to one project (name or UUID). Each milestone includes `archived_at` (string | null). Defaults to live milestones only — pass `include_archived: true` to also surface cascade-archived rows (parent-project archived). Round-7 / HIGH-2.",
      inputSchema: {
        project: z.string().optional().describe("Project name or UUID."),
        include_archived: z
          .boolean()
          .optional()
          .describe("Include cascade-archived milestones in the result. Defaults to false."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List project milestones",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      let projectId: string | undefined;
      if (args.project) {
        const resolved = await resolveProjectId(args.project);
        if (!resolved)
          throw new NotFoundError(
            `project not found: ${args.project}`,
            "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
          );
        projectId = resolved;
      }
      const milestones = await listMilestones({
        projectId,
        includeArchived: Boolean(args.include_archived),
      });
      return text(envelope({ count: milestones.length, milestones }));
    }),
  );

  server.registerTool(
    "get_milestone",
    {
      title: "Get one milestone by UUID",
      description:
        "Returns the milestone or null. Cascade-archived milestones (parent-project archived) are surfaced — distinguish via `archived_at`. Uses an archive-resilient list-shape query (the single-record `projectMilestone(id:)` getter silently drops cascade-archived rows; see docs/spec.md §12.1).",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one milestone by UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const milestone = await getMilestone(args.id);
      return text(envelope({ milestone }));
    }),
  );

  server.registerTool(
    "create_milestone",
    {
      title: "Create a project milestone",
      description: "Create within a project (name or UUID). NOT retry-wrapped.",
      inputSchema: {
        name: z.string(),
        project: z.string().describe("Project name or UUID."),
        description: z.string().optional(),
        target_date: z.string().optional().describe("ISO date, e.g. 2026-12-31."),
        sort_order: z.number().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create a project milestone",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const milestone = await createMilestone({
        name: args.name,
        projectId,
        description: args.description,
        targetDate: args.target_date,
        sortOrder: args.sort_order,
      });
      return text(envelope({ milestone }));
    }),
  );

  server.registerTool(
    "update_milestone",
    {
      title: "Update a milestone",
      description: "Idempotent at the value level — safe to retry.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        target_date: z
          .union([z.string(), z.null()])
          .optional()
          .describe("ISO date or null to clear."),
        sort_order: z.number().optional(),
        project: z.string().optional().describe("Move to a different project (name or UUID)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update a milestone",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const input: Parameters<typeof updateMilestone>[1] = {};
      if (args.name !== undefined) input.name = args.name;
      if (args.description !== undefined) input.description = args.description;
      if (args.target_date !== undefined) input.targetDate = args.target_date;
      if (args.sort_order !== undefined) input.sortOrder = args.sort_order;
      if (args.project) {
        const projectId = await resolveProjectId(args.project);
        if (!projectId)
          throw new NotFoundError(
            `project not found: ${args.project}`,
            "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
          );
        input.projectId = projectId;
      }
      if (Object.keys(input).length === 0) {
        throw new ValidationError(
          "nothing to update — pass at least one field",
          "pass at least one of the optional update fields",
        );
      }
      const milestone = await updateMilestone(args.id, input);
      return text(envelope({ milestone }));
    }),
  );

  server.registerTool(
    "delete_milestone",
    {
      title: "Delete a milestone",
      description:
        "Delete a milestone by UUID. Idempotent — re-deleting an already-absent milestone returns `{status: 'already-absent'}`. Round-7 / Q2.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete a milestone",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { status } = await tryIdempotentDelete(() => deleteMilestone(args.id));
      return text(envelope({ id: args.id, status, success: status === "deleted" }));
    }),
  );

  // ---------- projects ----------
  server.registerTool(
    "list_projects",
    {
      title: "List Linear projects",
      description: "List projects scoped to a team (default) or workspace-wide.",
      inputSchema: {
        team: z.string().optional().describe("Team key. Omit for workspace-wide."),
        state: z.string().optional(),
        limit: z.number().int().min(0).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List Linear projects",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const records = await listProjects({ team: args.team, state: args.state, max });
      // Wave-3 minor parity: include `team` in the envelope to mirror
      // `lebop projects --json`. Null for workspace-wide listings.
      return text(
        envelope({
          team: (args.team as string | null | undefined) ?? null,
          count: records.length,
          projects: records,
        }),
      );
    }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get one project by UUID",
      description: "Returns the project (with content + lead + teams) or null.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one project by UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const project = await getProject(args.id);
      return text(envelope({ project }));
    }),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description: "Requires team_ids (UUIDs). NOT retry-wrapped (would duplicate).",
      inputSchema: {
        name: z.string(),
        team_ids: z.array(z.string()).describe("Team UUIDs (NOT keys)."),
        description: z.string().optional(),
        content: z.string().optional(),
        state: z.string().optional(),
        start_date: z.string().optional(),
        target_date: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create a project",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const project = await createProject({
        name: args.name,
        teamIds: args.team_ids,
        description: args.description,
        content: args.content,
        state: args.state,
        startDate: args.start_date,
        targetDate: args.target_date,
      });
      return text(envelope({ project }));
    }),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update a project",
      description: "Idempotent at the value level — safe to retry.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        content: z.string().optional(),
        state: z.string().optional(),
        start_date: z.union([z.string(), z.null()]).optional(),
        target_date: z.union([z.string(), z.null()]).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update a project",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const input: Parameters<typeof updateProject>[1] = {};
      if (args.name !== undefined) input.name = args.name;
      if (args.description !== undefined) input.description = args.description;
      if (args.content !== undefined) input.content = args.content;
      if (args.state !== undefined) input.state = args.state;
      if (args.start_date !== undefined) input.startDate = args.start_date;
      if (args.target_date !== undefined) input.targetDate = args.target_date;
      if (Object.keys(input).length === 0) {
        throw new ValidationError(
          "nothing to update — pass at least one field",
          "pass at least one of the optional update fields",
        );
      }
      const project = await updateProject(args.id, input);
      return text(envelope({ project }));
    }),
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete a project",
      description:
        "Delete a project by UUID. Soft delete server-side (sets `archived_at`); not user-restorable via Linear's standard UI flows. Idempotent — re-deleting an already-soft-deleted project returns `{status: 'already-absent'}`. Round-7 / Q2.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete a project",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { status } = await tryIdempotentDelete(() => deleteProject(args.id));
      return text(envelope({ id: args.id, status, success: status === "deleted" }));
    }),
  );

  // ---------- project updates (with health) ----------
  server.registerTool(
    "list_project_updates",
    {
      title: "List project status updates",
      description: "Chronological status posts for one project.",
      inputSchema: {
        project: z.string().describe("Project name or UUID."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List project status updates",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const updates = await listProjectUpdates(projectId);
      return text(envelope({ project_id: projectId, count: updates.length, updates }));
    }),
  );

  server.registerTool(
    "create_project_update",
    {
      title: "Post a project status update",
      description:
        "Optionally tagged with health (onTrack | atRisk | offTrack). NOT retry-wrapped.",
      inputSchema: {
        project: z.string().describe("Project name or UUID."),
        body: z.string(),
        health: z.enum(["onTrack", "atRisk", "offTrack"]).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Post a project status update",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const update = await createProjectUpdate({
        projectId,
        body: args.body,
        health: args.health as ProjectHealth | undefined,
      });
      return text(envelope({ project_update: update }));
    }),
  );

  // ---------- initiatives ----------
  server.registerTool(
    "list_initiatives",
    {
      title: "List Linear initiatives",
      description: "Org-level planning units that group projects.",
      inputSchema: {
        status: z.string().optional(),
        owner_id: z.string().optional(),
        include_archived: z.boolean().optional(),
        limit: z.number().int().min(0).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List Linear initiatives",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const initiatives = await listInitiatives({
        status: args.status,
        ownerId: args.owner_id,
        includeArchived: args.include_archived,
        max,
      });
      return text(envelope({ count: initiatives.length, initiatives }));
    }),
  );

  server.registerTool(
    "get_initiative",
    {
      title: "Get one initiative (with linked projects)",
      description: "Returns null if not found. `id` accepts UUID or initiative name.",
      inputSchema: {
        id: z
          .string()
          .describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one initiative (with linked projects)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const resolved = await resolveInitiativeId(args.id as string);
      if (!resolved) return text(envelope({ initiative: null }));
      const initiative = await getInitiative(resolved);
      return text(envelope({ initiative }));
    }),
  );

  server.registerTool(
    "create_initiative",
    {
      title: "Create an initiative",
      description: "NOT retry-wrapped (would duplicate).",
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
        status: z.string().optional(),
        owner_id: z.string().optional(),
        target_date: z.string().optional(),
        color: z.string().optional(),
        icon: z
          .string()
          .optional()
          .describe(
            "Linear internal icon name (PascalCase, e.g. 'BarChart', 'Rocket', 'Target'). Emoji and arbitrary strings are rejected. Omit if unsure.",
          ),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create an initiative",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiative = await createInitiative({
        name: args.name,
        description: args.description,
        status: args.status,
        ownerId: args.owner_id,
        targetDate: args.target_date,
        color: args.color,
        icon: args.icon,
      });
      return text(envelope({ initiative }));
    }),
  );

  server.registerTool(
    "update_initiative",
    {
      title: "Update an initiative",
      description:
        "Idempotent at the value level — safe to retry. The `id` field accepts a UUID OR an initiative name (resolved via `resolveInitiativeId`, matching the behavior of `get_initiative` and `archive_initiative`).",
      inputSchema: {
        // Round-6 / A20: name lookup parity. `get_initiative` and
        // `archive_initiative` already accept either a UUID or a name;
        // `update_initiative` previously required a UUID only. We now route
        // both through `resolveInitiativeId` for consistency.
        id: z.string().describe("Initiative UUID OR name (resolved server-side)."),
        name: z.string().optional(),
        description: z.string().optional(),
        status: z.string().optional(),
        owner_id: z.union([z.string(), z.null()]).optional(),
        target_date: z.union([z.string(), z.null()]).optional(),
        color: z.string().optional(),
        icon: z
          .string()
          .optional()
          .describe(
            "Linear internal icon name (PascalCase, e.g. 'BarChart', 'Rocket', 'Target'). Emoji and arbitrary strings are rejected. Omit if unsure.",
          ),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update an initiative",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const input: Parameters<typeof updateInitiative>[1] = {};
      if (args.name !== undefined) input.name = args.name;
      if (args.description !== undefined) input.description = args.description;
      if (args.status !== undefined) input.status = args.status;
      if (args.owner_id !== undefined) input.ownerId = args.owner_id;
      if (args.target_date !== undefined) input.targetDate = args.target_date;
      if (args.color !== undefined) input.color = args.color;
      if (args.icon !== undefined) input.icon = args.icon;
      if (Object.keys(input).length === 0)
        throw new ValidationError(
          "nothing to update — pass at least one field",
          "pass at least one of the optional update fields",
        );
      // Round-6 / A20: accept name OR UUID — siblings already do.
      const initiativeId = await resolveInitiativeId(args.id as string);
      if (!initiativeId) {
        throw new NotFoundError(
          `initiative not found: ${args.id}`,
          "pass a UUID, or a name that matches an existing initiative (case-sensitive)",
        );
      }
      const initiative = await updateInitiative(initiativeId, input);
      return text(envelope({ initiative }));
    }),
  );

  server.registerTool(
    "archive_initiative",
    {
      title: "Archive an initiative (reversible)",
      description: "NOT retry-wrapped. `id` accepts UUID or initiative name.",
      inputSchema: {
        id: z
          .string()
          .describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Archive an initiative (reversible)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.id);
      if (!initiativeId) throw new NotFoundError(`initiative not found: ${args.id}`);
      const success = await archiveInitiative(initiativeId);
      return text(envelope({ id: initiativeId, success }));
    }),
  );

  server.registerTool(
    "unarchive_initiative",
    {
      title: "Unarchive an initiative",
      description: "NOT retry-wrapped. `id` accepts UUID or initiative name.",
      inputSchema: {
        id: z
          .string()
          .describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Unarchive an initiative",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.id);
      if (!initiativeId) throw new NotFoundError(`initiative not found: ${args.id}`);
      const success = await unarchiveInitiative(initiativeId);
      return text(envelope({ id: initiativeId, success }));
    }),
  );

  server.registerTool(
    "delete_initiative",
    {
      title: "Delete an initiative permanently",
      description:
        "Delete an initiative by UUID or exact name. Soft delete server-side (sets `archived_at`); not user-restorable via Linear's standard UI flows. Idempotent — re-deleting an already-soft-deleted initiative returns `{status: 'already-absent'}`. Round-7 / Q2.",
      inputSchema: {
        id: z
          .string()
          .describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete an initiative permanently",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      // Round-9 / M-1: envelope `id` is null when name lookup fails so
      // callers don't get a name-string in one branch and a UUID in the
      // other. `query` carries the original lookup token.
      const initiativeId = await resolveInitiativeId(args.id);
      if (!initiativeId)
        return text(
          envelope({ id: null, query: args.id, status: "already-absent", success: false }),
        );
      const { status } = await tryIdempotentDelete(() => deleteInitiative(initiativeId));
      return text(
        envelope({ id: initiativeId, query: args.id, status, success: status === "deleted" }),
      );
    }),
  );

  server.registerTool(
    "initiative_add_project",
    {
      title: "Link a project to an initiative",
      description: "Server-side idempotent at the (initiative, project) tuple.",
      inputSchema: {
        initiative: z.string().describe("Initiative name or UUID."),
        project: z.string().describe("Project name or UUID."),
        sort_order: z.number().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Link a project to an initiative",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId)
        throw new NotFoundError(
          `initiative not found: ${args.initiative}`,
          "pass the initiative name or UUID; run list_initiatives to discover ids",
        );
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const result = await initiativeAddProject({
        initiativeId,
        projectId,
        sortOrder: args.sort_order,
      });
      return text(envelope({ edge_id: result.id }));
    }),
  );

  server.registerTool(
    "initiative_remove_project",
    {
      title: "Unlink a project from an initiative",
      description:
        "Removes the link between a project and an initiative. " +
        "Returns { removed: boolean, reason?, message? }. " +
        "When `removed` is false, `reason` disambiguates the cause: " +
        "`absent` (no such link existed — already-removed or never-linked), " +
        "`archived` (the initiative is archived and refuses mutations — " +
        "unarchive_initiative first), or `other` (server-side rejection; " +
        "see `message`). When `removed` is true, no `reason` is set.",
      inputSchema: {
        initiative: z.string(),
        project: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Unlink a project from an initiative",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId)
        throw new NotFoundError(
          `initiative not found: ${args.initiative}`,
          "pass the initiative name or UUID; run list_initiatives to discover ids",
        );
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const result = await initiativeRemoveProject({ initiativeId, projectId });
      return text(envelope({ ...result }));
    }),
  );

  server.registerTool(
    "list_initiative_updates",
    {
      title: "List initiative status updates",
      description: "Chronological status posts for one initiative.",
      inputSchema: {
        initiative: z.string().describe("Initiative name or UUID."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List initiative status updates",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId)
        throw new NotFoundError(
          `initiative not found: ${args.initiative}`,
          "pass the initiative name or UUID; run list_initiatives to discover ids",
        );
      const updates = await listInitiativeUpdates(initiativeId);
      return text(
        envelope({
          initiative_id: initiativeId,
          count: updates.length,
          updates,
        }),
      );
    }),
  );

  server.registerTool(
    "create_initiative_update",
    {
      title: "Post an initiative status update (with health)",
      description: "NOT retry-wrapped (would duplicate).",
      inputSchema: {
        initiative: z.string(),
        body: z.string(),
        health: z.enum(["onTrack", "atRisk", "offTrack"]).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Post an initiative status update (with health)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId)
        throw new NotFoundError(
          `initiative not found: ${args.initiative}`,
          "pass the initiative name or UUID; run list_initiatives to discover ids",
        );
      const update = await createInitiativeUpdate({
        initiativeId,
        body: args.body,
        health: args.health as InitiativeHealth | undefined,
      });
      return text(envelope({ initiative_update: update }));
    }),
  );

  // ---------- cycles ----------
  server.registerTool(
    "list_cycles",
    {
      title: "List cycles for a team (or all teams)",
      description: "Cycles are read-only via lebop — manage in the Linear UI.",
      inputSchema: {
        team: z.string().optional(),
        limit: z.number().int().min(0).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List cycles for a team (or all teams)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const cycles = await listCycles({ team: args.team, max });
      return text(envelope({ count: cycles.length, cycles }));
    }),
  );

  server.registerTool(
    "get_cycle",
    {
      title: "Get one cycle by UUID",
      description: "Returns null if not found.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one cycle by UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const cycle = await getCycle(args.id);
      return text(envelope({ cycle }));
    }),
  );

  // ---------- documents ----------
  server.registerTool(
    "list_documents",
    {
      title: "List Linear documents",
      description: "Pass project (name or UUID) to filter to one project's docs.",
      inputSchema: {
        project: z.string().optional(),
        limit: z.number().int().min(0).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List Linear documents",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      let projectId: string | undefined;
      if (args.project) {
        const resolved = await resolveProjectId(args.project);
        if (!resolved)
          throw new NotFoundError(
            `project not found: ${args.project}`,
            "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
          );
        projectId = resolved;
      }
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const documents = await listDocuments({ projectId, max });
      return text(envelope({ count: documents.length, documents }));
    }),
  );

  server.registerTool(
    "get_document",
    {
      title: "Get one document by UUID (with content)",
      description: "Returns null if not found.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one document by UUID (with content)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const document = await getDocument(args.id);
      return text(envelope({ document }));
    }),
  );

  server.registerTool(
    "create_document",
    {
      title: "Create a document",
      description: "Must be attached to a project. NOT retry-wrapped.",
      inputSchema: {
        title: z.string(),
        project: z.string().describe("Project name or UUID."),
        content: z.string().optional(),
        icon: z
          .string()
          .optional()
          .describe(
            "Linear internal icon name (PascalCase, e.g. 'BarChart', 'Rocket', 'Target'). Emoji and arbitrary strings are rejected. Omit if unsure.",
          ),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create a document",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const document = await createDocument({
        title: args.title,
        projectId,
        content: args.content,
        icon: args.icon,
      });
      return text(envelope({ document }));
    }),
  );

  server.registerTool(
    "update_document",
    {
      title: "Update a document",
      description: "Idempotent at the value level — safe to retry.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        content: z.string().optional(),
        icon: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update a document",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const input: Parameters<typeof updateDocument>[1] = {};
      if (args.title !== undefined) input.title = args.title;
      if (args.content !== undefined) input.content = args.content;
      if (args.icon !== undefined) input.icon = args.icon;
      if (Object.keys(input).length === 0)
        throw new ValidationError(
          "nothing to update — pass at least one field",
          "pass at least one of the optional update fields",
        );
      const document = await updateDocument(args.id, input);
      return text(envelope({ document }));
    }),
  );

  server.registerTool(
    "delete_document",
    {
      title: "Delete a document permanently",
      description:
        "Delete a document by UUID. Soft delete server-side (sets `archived_at`); not user-restorable via Linear's standard UI flows. Idempotent — re-deleting an already-soft-deleted document returns `{status: 'already-absent'}`. Round-7 / Q2.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete a document permanently",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { status } = await tryIdempotentDelete(() => deleteDocument(args.id));
      return text(envelope({ id: args.id, status, success: status === "deleted" }));
    }),
  );

  // ---------- agent sessions ----------
  server.registerTool(
    "list_agent_sessions",
    {
      title: "List Linear agent sessions",
      description: "Read-only. Filter by status or scope to one issue.",
      inputSchema: {
        status: z.string().optional(),
        issue_id: z.string().optional().describe("Issue UUID."),
        limit: z.number().int().min(0).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List Linear agent sessions",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const sessions = await listAgentSessions({
        status: args.status,
        issueId: args.issue_id,
        max,
      });
      return text(envelope({ count: sessions.length, agent_sessions: sessions }));
    }),
  );

  server.registerTool(
    "get_agent_session",
    {
      title: "Get one agent session by UUID",
      description: "Returns null if not found.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one agent session by UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const session = await getAgentSession(args.id);
      return text(envelope({ agent_session: session }));
    }),
  );

  // ---------- team members ----------
  server.registerTool(
    "list_team_members",
    {
      title: "List members of a team",
      description: "Pass include_inactive=true to see deactivated users.",
      inputSchema: {
        // Renamed from `team_key` → `team` in v0.0.2 for consistency with
        // every other tool that takes a team identifier. The lib still
        // calls the value a `teamKey` internally; the MCP boundary
        // normalizes naming. RELEASE NOTE BREAKING CHANGE: MCP clients
        // wiring up list_team_members must rename `team_key` → `team`.
        team: z.string().describe("Team key (e.g. 'NOX')."),
        include_inactive: z.boolean().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List members of a team",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const members = await listTeamMembers({
        teamKey: args.team as string,
        includeInactive: args.include_inactive as boolean | undefined,
      });
      return text(envelope({ team: args.team, count: members.length, members }));
    }),
  );

  // ---------- lint_text ----------
  // Differentiator tool — neither linear-cli nor Linear's MCP has this.
  server.registerTool(
    "lint_text",
    {
      title: "Lint markdown for Linear renderer quirks",
      description:
        "Run lebop's universal lint rules (L001-L006) against in-memory text content. Catches table-cell ordered-list markers, setext H2 from `text\\n---`, etc. Returns warnings + a fixed version when --fix-equivalent applied. NOTE: this tool takes a content string, NOT a file path. For path-based linting (walking cache directories, in-repo markdown files) use the CLI: `lebop lint [paths...]`. The two surfaces are intentionally different operations sharing one rules engine.",
      inputSchema: {
        content: z.string().describe("Markdown content to lint."),
      },
      annotations: {
        title: "Lint markdown for Linear renderer quirks",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { warnings } = lintContent(args.content, {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope({
                warning_count: warnings.length,
                warnings: warnings.map((w) => ({
                  rule: w.rule,
                  severity: w.severity,
                  message: w.message,
                  line: w.line,
                })),
              }),
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // ==========================================================================
  // Issue lifecycle (5 tools): get / create / update / archive / unarchive
  // ==========================================================================

  server.registerTool(
    "get_issue",
    {
      title: "Get a single Linear issue",
      description:
        "Fetch one issue by identifier (TEAM-NN). Returns full metadata + description + comments + relations + parent/sub-issues. Returns `{issue: null}` if the identifier is not found (round-8 / H1 alignment with the other `get_*` tools).",
      inputSchema: {
        identifier: z.string().describe("Issue identifier, e.g. 'NOX-321'."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get a single Linear issue",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const issue = await getIssue(args.identifier as string);
      return text(envelope({ issue }));
    }),
  );

  server.registerTool(
    "create_issue",
    {
      title: "Create a new Linear issue",
      description:
        "Creates one issue. NOT retry-wrapped — duplicate creation could result if the response is lost mid-call.",
      inputSchema: {
        team: z.string().describe("Team key (e.g. 'NOX')."),
        title: z.string(),
        description: z.string().optional(),
        project: z.string().optional().describe("Project name (resolved against the team)."),
        project_id: z.string().optional().describe("Project UUID (skips name lookup)."),
        state: z.string().optional().describe("State name; defaults to team default state."),
        priority: z
          .union([z.string(), z.number()])
          .optional()
          .describe("'urgent' | 'high' | 'normal' | 'low' | 'none' or 0..4."),
        estimate: z.number().optional(),
        labels: z.array(z.string()).optional().describe("Label names; resolved per team."),
        assignee: z.string().optional().describe("'me' | email | display-name."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create a new Linear issue",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const issue = await createIssue({
        team: args.team as string,
        title: args.title as string,
        description: args.description as string | undefined,
        project: args.project as string | undefined,
        projectId: args.project_id as string | undefined,
        state: args.state as string | undefined,
        priority: args.priority as string | number | undefined,
        estimate: args.estimate as number | undefined,
        labels: args.labels as string[] | undefined,
        assignee: args.assignee as string | undefined,
      });
      return text(envelope({ issue }));
    }),
  );

  server.registerTool(
    "update_issue",
    {
      title: "Update fields on an existing Linear issue",
      description:
        "Set any combination of: title, description, state, priority, estimate, labels, assignee, parent, project, milestone, cycle. Idempotent at the value level — safe to retry.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier (TEAM-NN)."),
        team: z
          .string()
          .optional()
          .describe(
            "Team key. Auto-derived from the issue identifier prefix when omitted (e.g. 'NOX-1' → 'NOX'). Pass explicitly only to override the derived team. Required when state/labels/assignee names are passed AND the identifier prefix can't be derived.",
          ),
        title: z.string().optional(),
        description: z.string().optional(),
        state: z.string().optional(),
        priority: z.union([z.string(), z.number()]).optional(),
        estimate: z.number().nullable().optional().describe("Number, or null to clear."),
        labels: z.array(z.string()).optional().describe("Replaces the full label set."),
        assignee: z.string().nullable().optional().describe("'me'|email|name, or null to clear."),
        parent: z
          .string()
          .nullable()
          .optional()
          .describe("Parent issue identifier, or null to clear."),
        project: z.string().nullable().optional().describe("Project name or UUID; null to detach."),
        milestone: z
          .string()
          .nullable()
          .optional()
          .describe("Milestone name or UUID; null to detach. Belongs to the issue's project."),
        cycle: z.string().nullable().optional().describe("Cycle name or UUID; null to detach."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update fields on an existing Linear issue",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      // Wave-3: thin pass-through to lib/updateIssue, which now handles all
      // 11 update fields (title/description/state/priority/estimate/labels/
      // assignee/parent/project/milestone/cycle) in a single GraphQL
      // mutation. The wave-2 two-step "call lib, then raw extras mutation"
      // dance is gone — fewer round-trips, no half-applied state on a bad
      // milestone name, single source of truth for resolution semantics.
      const issue = await updateIssue({
        identifier: args.identifier as string,
        team: args.team as string | undefined,
        title: args.title as string | undefined,
        description: args.description as string | undefined,
        state: args.state as string | undefined,
        priority: args.priority as string | number | undefined,
        estimate: args.estimate as number | null | undefined,
        labels: args.labels as string[] | undefined,
        assignee: args.assignee as string | null | undefined,
        parent: args.parent as string | null | undefined,
        project: args.project as string | null | undefined,
        milestone: args.milestone as string | null | undefined,
        cycle: args.cycle as string | null | undefined,
      });
      return text(envelope({ issue }));
    }),
  );

  server.registerTool(
    "archive_issue",
    {
      title: "Archive one or more issues",
      description:
        "Archives one or more issues (reversible from the Linear UI; reversible programmatically via unarchive_issue). NOT retry-wrapped.",
      inputSchema: {
        identifiers: z.array(z.string()).describe("Issue identifiers (TEAM-NN format)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Archive one or more issues",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const results = await archiveIssues(args.identifiers as string[]);
      return text(envelope({ results }));
    }),
  );

  server.registerTool(
    "unarchive_issue",
    {
      title: "Unarchive one or more issues",
      description: "Reverse of archive_issue. NOT retry-wrapped.",
      inputSchema: {
        identifiers: z.array(z.string()),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Unarchive one or more issues",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const results = await unarchiveIssues(args.identifiers as string[]);
      return text(envelope({ results }));
    }),
  );

  // ==========================================================================
  // Comments (4 tools): list / add / update / delete
  // ==========================================================================

  server.registerTool(
    "list_comments",
    {
      title: "List comments on an issue",
      description: "Returns all comments on the given issue, chronologically.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier (TEAM-NN)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List comments on an issue",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const comments = await listComments(args.identifier as string);
      return text(
        envelope({
          identifier: args.identifier,
          count: comments.length,
          comments,
        }),
      );
    }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add a comment to an issue",
      description: "Posts one comment. NOT retry-wrapped — would post a duplicate.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier (TEAM-NN)."),
        body: z.string(),
        parent_id: z.string().optional().describe("UUID of parent comment when replying."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Add a comment to an issue",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const result = await addComment({
        identifier: args.identifier as string,
        body: args.body as string,
        parentId: args.parent_id as string | undefined,
      });
      return text(envelope({ identifier: args.identifier, comment: result }));
    }),
  );

  server.registerTool(
    "update_comment",
    {
      title: "Update an existing comment",
      description: "Idempotent at the value level — safe to retry.",
      inputSchema: {
        id: z.string().describe("Comment UUID (visible in list_comments)."),
        body: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update an existing comment",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const result = await updateComment(args.id as string, args.body as string);
      return text(envelope({ comment: result }));
    }),
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete a comment by UUID",
      description:
        "Delete a comment by UUID. Idempotent — re-deleting an already-absent comment returns `{status: 'already-absent'}`. Round-7 / Q2.",
      inputSchema: {
        id: z.string().describe("Comment UUID."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete a comment by UUID",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { status } = await tryIdempotentDelete(() => deleteComment(args.id as string));
      return text(envelope({ id: args.id, status, success: status === "deleted" }));
    }),
  );

  // ==========================================================================
  // Cache loop (4 tools): pull_issues / push_changes / cache_status / diff_issue
  // ==========================================================================

  server.registerTool(
    "cache_status",
    {
      title: "git-like status for the local lebop cache",
      description:
        "Returns modified / clean / stale entries in the cache. `stale` means the remote `updatedAt` is newer than the local `_server.updated_at` snapshot — pull_issues with refresh=true to update.",
      inputSchema: {
        repo_root: z
          .string()
          .optional()
          .describe(
            "Override the cwd-derived repo root. When omitted, uses the MCP server's cwd → git root.",
          ),
        team: z.string().optional(),
        check_remote: z
          .boolean()
          .optional()
          .describe("Run the remote-staleness check. Defaults to true."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "git-like status for the local lebop cache",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      // Wave-3 parity (item #2): emit the same nested {modified:{issues,projects},
      // clean:{issues,projects}} shape the CLI's `lebop status --json` uses.
      // The CLI shape is strictly richer (project entries carry name + fields),
      // and unifying on it costs nothing for agents that previously read the
      // flat MCP shape — the project arrays are simply additive.
      //
      // Item #5: cache_status has no `identifiers` arg to derive from, so we
      // can't short-circuit team resolution the way pull/diff/push do. If a
      // team is required and missing, resolveConfig surfaces the standard
      // error.
      const config = await resolveConfig({
        cwd: args.repo_root as string | undefined,
        teamOverride: args.team as string | undefined,
      });

      const issueIds = await listCachedIssues(config.repoHash);
      type IssueEntry = {
        identifier: string;
        metadata: IssueMetadata;
        fields: string[];
      };
      const validIssues: IssueEntry[] = [];
      for (const id of issueIds) {
        const loaded = await readIssue(config.repoHash, id);
        if (!loaded) continue;
        const changes = diffIssueMetadata(loaded.metadata, loaded.description);
        validIssues.push({
          identifier: id,
          metadata: loaded.metadata,
          fields: changes.map((c) => c.field),
        });
      }
      const modifiedIssues = validIssues.filter((r) => r.fields.length > 0);
      const cleanIssues = validIssues.filter((r) => r.fields.length === 0);

      const projectIds = await listCachedProjectIds(config.repoHash);
      type ProjectEntry = {
        id: string;
        metadata: ProjectMetadata;
        fields: string[];
      };
      const validProjects: ProjectEntry[] = [];
      for (const pid of projectIds) {
        const loaded = await readProject(config.repoHash, pid);
        if (!loaded) continue;
        const changes = diffProjectMetadata(loaded.metadata, loaded.content);
        validProjects.push({
          id: pid,
          metadata: loaded.metadata,
          fields: changes.map((c) => c.field),
        });
      }
      const modifiedProjects = validProjects.filter((r) => r.fields.length > 0);
      const cleanProjects = validProjects.filter((r) => r.fields.length === 0);

      let stale: { identifier: string; server_updated_at: string; remote_updated_at: string }[] =
        [];
      let stale_check: "ok" | "errored" | "skipped" = "skipped";
      const checkRemote = args.check_remote !== false && cleanIssues.length > 0;
      if (checkRemote) {
        try {
          const ids = cleanIssues.map((r) => r.identifier);
          const query = buildCasQuery(ids);
          const response = (await withClient((c) => c.client.rawRequest(query))) as {
            data: Record<string, { id: string; identifier: string; updatedAt: string } | null>;
          };
          stale = ids.flatMap((_id, i) => {
            const entry = cleanIssues[i];
            const remote = response.data[`a${i}`];
            if (!entry || !remote) return [];
            const localT = Date.parse(entry.metadata._server.updated_at);
            const remoteT = Date.parse(remote.updatedAt);
            if (remoteT > localT) {
              return [
                {
                  identifier: entry.identifier,
                  server_updated_at: entry.metadata._server.updated_at,
                  remote_updated_at: remote.updatedAt,
                },
              ];
            }
            return [];
          });
          stale_check = "ok";
        } catch {
          stale_check = "errored";
        }
      }
      const staleSet = new Set(stale.map((s) => s.identifier));
      return text(
        envelope({
          team: config.team,
          repo_root: config.repoRoot,
          repo_hash: config.repoHash,
          modified: {
            issues: modifiedIssues.map((m) => ({
              identifier: m.identifier,
              fields: m.fields,
            })),
            projects: modifiedProjects.map((p) => ({
              id: p.id,
              name: p.metadata.name,
              fields: p.fields,
            })),
          },
          stale,
          stale_check,
          clean: {
            issues: cleanIssues.filter((c) => !staleSet.has(c.identifier)).map((c) => c.identifier),
            projects: cleanProjects.map((c) => c.id),
          },
        }),
      );
    }),
  );

  server.registerTool(
    "diff_issue",
    {
      title: "unified diff: local cache vs live remote (one issue)",
      description:
        "Field-level diff + description unified-patch for a single cached issue. Returns null patch if no description drift.",
      inputSchema: {
        identifier: z.string(),
        repo_root: z.string().optional(),
        team: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "unified diff: local cache vs live remote (one issue)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const upperId = (args.identifier as string).toUpperCase();
      // Round-6 / A15: Linear may have renamed the team (e.g. UE → ENG)
      // after the cache was written, in which case `UE-359` resolves on
      // Linear but the cache is keyed under `ENG-359`. Fetch the remote
      // FIRST and use its canonical `identifier` for the cache lookup so
      // the rename-edge-case stops surfacing as "not in local cache".
      // Item #5: derive team from the identifier when not explicitly given.
      const teamOverride =
        (args.team as string | undefined) ?? deriveTeamFromIdentifiers([upperId]) ?? undefined;
      const config = await resolveConfig({
        cwd: args.repo_root as string | undefined,
        teamOverride,
      });
      const query = buildPullIssuesQuery([upperId], false);
      const response = (await withClient((c) => c.client.rawRequest(query))) as {
        data: Record<string, FetchedIssue | null>;
      };
      const remoteNode = response.data.a0;
      if (!remoteNode)
        throw new NotFoundError(`not found: ${upperId}`, `verify ${upperId} exists on Linear`);
      // Canonical identifier (Linear normalizes via team-rename redirect).
      const canonicalId = remoteNode.identifier.toUpperCase();
      // Try cache under canonical first, then the user-supplied form for
      // legacy caches written before the rename. Either is fine — Linear's
      // identifier maps uniquely back to the same UUID.
      const local =
        (await readIssue(config.repoHash, canonicalId)) ??
        (canonicalId !== upperId ? await readIssue(config.repoHash, upperId) : null);
      if (!local) {
        throw new ValidationError(
          `${canonicalId} is not in the local cache`,
          "run pull_issues with this identifier first",
        );
      }

      const { metadata: remoteMeta } = buildIssueMetadata(remoteNode);
      const remoteBody = remoteNode.description ?? "";

      const fields: { field: string; local: unknown; remote: unknown }[] = [];
      if (local.metadata.title !== remoteMeta.title) {
        fields.push({ field: "title", local: local.metadata.title, remote: remoteMeta.title });
      }
      if (local.metadata.state !== remoteMeta.state) {
        fields.push({ field: "state", local: local.metadata.state, remote: remoteMeta.state });
      }
      if (local.metadata.priority !== remoteMeta.priority) {
        fields.push({
          field: "priority",
          local: local.metadata.priority,
          remote: remoteMeta.priority,
        });
      }
      if ((local.metadata.estimate ?? null) !== (remoteMeta.estimate ?? null)) {
        fields.push({
          field: "estimate",
          local: local.metadata.estimate,
          remote: remoteMeta.estimate,
        });
      }
      const localLabels = [...local.metadata.labels].sort();
      const remoteLabels = [...remoteMeta.labels].sort();
      if (!arraysEqual(localLabels, remoteLabels)) {
        fields.push({ field: "labels", local: localLabels, remote: remoteLabels });
      }
      if ((local.metadata.assignee ?? null) !== (remoteMeta.assignee ?? null)) {
        fields.push({
          field: "assignee",
          local: local.metadata.assignee,
          remote: remoteMeta.assignee,
        });
      }
      if ((local.metadata.parent ?? null) !== (remoteMeta.parent ?? null)) {
        fields.push({ field: "parent", local: local.metadata.parent, remote: remoteMeta.parent });
      }

      const patch = createTwoFilesPatch(
        `a/${upperId}/description.md`,
        `b/${upperId}/description.md`,
        remoteBody,
        local.description,
        "remote (live)",
        "local (cache)",
        { context: 3 },
      );
      const descChanged = patch
        .split("\n")
        .some(
          (l) =>
            (l.startsWith("+") && !l.startsWith("+++")) ||
            (l.startsWith("-") && !l.startsWith("---")),
        );

      return text(
        envelope({
          identifier: upperId,
          fields,
          description_changed: descChanged,
          description_patch: descChanged ? patch : null,
        }),
      );
    }),
  );

  server.registerTool(
    "pull_issues",
    {
      title: "Fetch issues into the local cache",
      description:
        "Pull a set of issues by identifier into ~/.lebop/cache/<repo-hash>/issues/<id>/. Refuses to overwrite cached issues with unpushed local edits unless refresh=true.",
      inputSchema: {
        identifiers: z.array(z.string()).describe("Issue identifiers (TEAM-NN)."),
        repo_root: z.string().optional(),
        team: z.string().optional(),
        refresh: z
          .boolean()
          .optional()
          .describe("Overwrite cached issues that have unpushed local edits."),
        include_comments: z.boolean().optional().describe("Default true."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Fetch issues into the local cache",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const ids = args.identifiers as string[];
      // Item #5: if no explicit team, derive from identifier prefixes so the
      // common single-team case doesn't fail with "no team resolved" when the
      // identifier itself unambiguously names the team.
      const teamOverride =
        (args.team as string | undefined) ?? deriveTeamFromIdentifiers(ids) ?? undefined;
      const config = await resolveConfig({
        cwd: args.repo_root as string | undefined,
        teamOverride,
      });
      const refresh = args.refresh === true;
      const withComments = args.include_comments !== false;

      // Refuse to overwrite unpushed edits unless refresh=true.
      if (!refresh) {
        const conflicts: string[] = [];
        for (const id of ids) {
          const existing = await readIssue(config.repoHash, id);
          if (existing && diffIssueMetadata(existing.metadata, existing.description).length > 0) {
            conflicts.push(id);
          }
        }
        if (conflicts.length > 0) {
          throw new ValidationError(
            `refusing to overwrite local edits on: ${conflicts.join(", ")}`,
            "push the modified issues first, or pass refresh=true to discard local edits",
          );
        }
      }

      const query = buildPullIssuesQuery(ids, withComments);
      const response = (await withClient((c) => c.client.rawRequest(query))) as {
        data: Record<string, FetchedIssue | null>;
      };

      // Wave-3 parity (item #4): emit the same envelope shape as `lebop pull
      // --json` — adds team / repo_hash / mode / project alongside issues.
      // Agents need repo_hash to make a subsequent cache_status call against
      // the right per-repo cache directory; without it they'd be guessing.
      // `mode` is always "cache" here — the MCP doesn't expose an export
      // destination flag (that's a CLI-only filesystem-output affordance).
      // `project` is always null for pull_issues (the MCP analog of the CLI's
      // `pull --project` lives in a sibling tool; here we only pull issues).
      // Field is included for shape parity so downstream readers can rely on
      // its presence.
      const issues: { identifier: string; comments: number; cache_path: string }[] = [];
      const errors: { identifier: string; error: string }[] = [];

      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (!id) continue;
        const node = response.data[`a${i}`];
        if (!node) {
          errors.push({ identifier: id, error: `not found: ${id}` });
          continue;
        }
        const { metadata, description } = buildIssueMetadata(node);
        await writeIssue(config.repoHash, metadata, description);
        const cached = withComments ? buildComments(node) : [];
        for (const c of cached) {
          await writeComment(config.repoHash, node.identifier, c);
        }
        issues.push({
          identifier: node.identifier,
          comments: cached.length,
          cache_path: issueDir(config.repoHash, node.identifier),
        });
      }
      return text(
        envelope({
          team: config.team,
          repo_hash: config.repoHash,
          mode: "cache" as const,
          project: null,
          issues,
          errors,
        }),
      );
    }),
  );

  server.registerTool(
    "push_changes",
    {
      title: "Push locally-modified cache entries back to Linear (CAS-protected)",
      description:
        "Reads the local cache, computes per-issue field diffs, and applies updates as Linear mutations. CAS-protected via _server.updated_at; pass force=true to bypass. dry_run=true previews without writing.",
      inputSchema: {
        identifiers: z
          .array(z.string())
          .optional()
          .describe("Restrict to these identifiers; defaults to every modified cached issue."),
        repo_root: z.string().optional(),
        team: z.string().optional(),
        dry_run: z.boolean().optional(),
        force: z.boolean().optional().describe("Bypass the CAS check."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Push locally-modified cache entries back to Linear (CAS-protected)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const requested = args.identifiers as string[] | undefined;
      // Item #5: derive team from the requested identifiers when not given
      // explicitly. When identifiers is omitted (push everything modified),
      // fall back to the resolveConfig default chain.
      const teamOverride =
        (args.team as string | undefined) ??
        (requested && requested.length > 0
          ? (deriveTeamFromIdentifiers(requested) ?? undefined)
          : undefined);
      const config = await resolveConfig({
        cwd: args.repo_root as string | undefined,
        teamOverride,
      });
      const dryRun = args.dry_run === true;
      const force = args.force === true;

      const cachedIds = await listCachedIssues(config.repoHash);
      const candidates = requested ? cachedIds.filter((id) => requested.includes(id)) : cachedIds;

      // Wave-3 parity (item #3): emit the richer {target, kind, status: "pushed"|...}
      // shape the CLI uses. `target` carries the human-facing identifier or
      // project name; `kind` will let us add project pushes later without
      // re-versioning. The MCP previously emitted {identifier, status:"updated"};
      // agents using the old shape can map `target` → `identifier` 1:1 for
      // issues. `kind` is currently always "issue" — placeholder for parity
      // with `lebop push` which already handles project rows.
      const results: {
        target: string;
        kind: "issue" | "project";
        status: "pushed" | "unchanged" | "stale" | "not-found" | "dry-run" | "error";
        fields?: string[];
        error?: string;
      }[] = [];

      // CAS check first: fetch remote updatedAt for the candidate set.
      let remoteCas: Record<string, { id: string; updatedAt: string } | null> = {};
      if (candidates.length > 0 && !force) {
        const query = buildCasQuery(candidates);
        const response = (await withClient((c) => c.client.rawRequest(query))) as {
          data: Record<string, { id: string; identifier: string; updatedAt: string } | null>;
        };
        remoteCas = response.data;
      }

      for (let i = 0; i < candidates.length; i++) {
        const id = candidates[i];
        if (!id) continue;
        const loaded = await readIssue(config.repoHash, id);
        if (!loaded) {
          results.push({ target: id, kind: "issue", status: "not-found" });
          continue;
        }
        const changes = diffIssueMetadata(loaded.metadata, loaded.description);
        if (changes.length === 0) {
          results.push({ target: id, kind: "issue", status: "unchanged" });
          continue;
        }

        if (!force) {
          const remote = remoteCas[`a${i}`];
          if (remote) {
            const localT = Date.parse(loaded.metadata._server.updated_at);
            const remoteT = Date.parse(remote.updatedAt);
            if (remoteT > localT) {
              results.push({
                target: id,
                kind: "issue",
                status: "stale",
                fields: changes.map((c) => c.field),
              });
              continue;
            }
          }
        }

        if (dryRun) {
          results.push({
            target: id,
            kind: "issue",
            status: "dry-run",
            fields: changes.map((c) => c.field),
          });
          continue;
        }

        // Apply mutation. Use the shared lib helper so all field types
        // (title/description/state/priority/estimate/labels/assignee/parent)
        // resolve identically to the CLI `lebop push` path. team metadata is
        // fetched lazily so a push containing only title/description still
        // works without a configured team (the helper short-circuits on
        // unused fields).
        let linearInput: Record<string, unknown>;
        try {
          const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
          linearInput = (await buildIssueUpdateInput(
            {
              identifier: id,
              metadata: loaded.metadata,
              description: loaded.description,
              changes,
            },
            teamMetadata,
          )) as Record<string, unknown>;
        } catch (err) {
          results.push({
            target: id,
            kind: "issue",
            status: "error",
            fields: changes.map((c) => c.field),
            error: (err as Error).message,
          });
          continue;
        }
        if (Object.keys(linearInput).length === 0) {
          results.push({ target: id, kind: "issue", status: "unchanged" });
          continue;
        }
        try {
          const remote = remoteCas[`a${i}`] ?? null;
          const issueUuid = remote?.id ?? loaded.metadata._server.id;
          if (!issueUuid) {
            results.push({ target: id, kind: "issue", status: "not-found" });
            continue;
          }
          const response = (await withClient((c) =>
            c.client.rawRequest(ISSUE_UPDATE_MUTATION, {
              id: issueUuid,
              input: linearInput,
            }),
          )) as { data: { issueUpdate: { success: boolean; issue: FetchedIssue } } };
          // Persist server-normalized state so subsequent cache_status / diff
          // shows clean. Linear may reflow markdown (blank lines around ---,
          // etc.); without writing the server's version back, _server stays
          // out of sync with the on-disk file and status reads "modified"
          // forever.
          const updated = response.data.issueUpdate.issue;
          const rebuilt = buildIssueMetadata(updated);
          await writeIssue(config.repoHash, rebuilt.metadata, updated.description ?? "");
          results.push({
            target: id,
            kind: "issue",
            status: "pushed",
            fields: changes.map((c) => c.field),
          });
        } catch (err) {
          results.push({
            target: id,
            kind: "issue",
            status: "error",
            fields: changes.map((c) => c.field),
            error: (err as Error).message,
          });
        }
      }

      return text(
        envelope({
          results,
          notes: dryRun ? "dry-run: nothing was written" : undefined,
        }),
      );
    }),
  );

  // ==========================================================================
  // Plan workflow (4 tools): validate / apply / diff / pull
  // ==========================================================================

  server.registerTool(
    "plan_validate",
    {
      title: "Validate a plan directory (no Linear writes)",
      description:
        "Parses + validates a directory of plan markdown files (frontmatter + body). Reports errors (must-fix) and warnings (renderer quirks, relation-pair conflicts, slug shadows, etc.). Pass team to enable network-dependent semantic checks (state/label/assignee resolution).",
      inputSchema: {
        dir: z.string().describe("Plan directory path (absolute or relative to MCP server cwd)."),
        team: z
          .string()
          .optional()
          .describe("Team key — if provided, runs full semantic checks against team metadata."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Validate a plan directory (no Linear writes)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      // Skip semantic checks unless team provided — this mirrors `lebop plan validate`.
      const result = validatePlan(plan, null);
      // Wave-3 parity (item #8): adopt the CLI's richer plan-parse summary
      // shape (project.name + project.linear_id, full issues[] with slug +
      // title + linear_id) on top of the validation errors/warnings. The
      // previous MCP shape (`issue_count`, no per-issue records) was a strict
      // subset; the CLI shape lets agents enumerate slugs without a second
      // parse round-trip.
      return text(
        envelope({
          dir,
          project: {
            name: plan.project.frontmatter.name,
            linear_id: plan.project.frontmatter.linear_id ?? null,
          },
          issues: plan.issues.map((i) => ({
            slug: i.slug,
            title: i.frontmatter.title,
            linear_id: i.frontmatter.linear_id ?? null,
          })),
          errors: result.errors,
          warnings: result.warnings,
        }),
      );
    }),
  );

  server.registerTool(
    "plan_apply",
    {
      title: "Realize a plan as a Linear project + issues + relations",
      description:
        "Idempotent: re-running on an unchanged plan is a no-op. Writes back `linear_id:` to each file on first apply. Set dry_run=true to preview. strict=true blocks on lint warnings.",
      inputSchema: {
        dir: z.string(),
        dry_run: z.boolean().optional(),
        strict: z.boolean().optional(),
        team: z
          .string()
          .optional()
          .describe("Override the resolved team (defaults to project frontmatter team)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Realize a plan as a Linear project + issues + relations",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      const teamKey = (args.team as string | undefined) ?? plan.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: teamKey });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      const dryRun = args.dry_run === true;
      const result = await applyPlan(plan, teamMetadata, {
        dryRun,
        strict: args.strict === true,
      });
      // Wave-3 parity (item #9): include `dry_run` in the output envelope to
      // match `lebop plan apply --json` — agents inspecting the response can
      // distinguish a real apply from a preview without re-checking the
      // request args. Schema already documents `dry_run` as a knob; this just
      // surfaces the resolved value.
      return text(envelope({ dir, dry_run: dryRun, ...result }));
    }),
  );

  server.registerTool(
    "plan_diff",
    {
      title: "Local-vs-remote drift for a plan directory",
      description:
        "Computes per-entity drift between the plan files and Linear's current state. Output mirrors `lebop plan diff`.",
      inputSchema: {
        dir: z.string(),
        team: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Local-vs-remote drift for a plan directory",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      const teamKey = (args.team as string | undefined) ?? plan.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: teamKey });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      const result = await diffPlan(plan, teamMetadata);
      return text(envelope({ dir, ...result }));
    }),
  );

  server.registerTool(
    "plan_pull",
    {
      title: "Overwrite plan files with current remote state",
      description:
        "Reverse of plan_apply for the local files: rewrites each plan file's frontmatter + body to match Linear. Refuses to overwrite locally-modified files unless force=true.",
      inputSchema: {
        dir: z.string(),
        force: z.boolean().optional(),
        include_new: z
          .boolean()
          .optional()
          .describe("Also import remote issues that don't have a corresponding plan file."),
        team: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Overwrite plan files with current remote state",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      const teamKey = (args.team as string | undefined) ?? plan.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: teamKey });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      // PullOpts only supports includeNew today — force flag is CLI-only
      // (it's a per-file overwrite gate that the CLI enforces around the lib).
      const result = await pullPlan(plan, teamMetadata, {
        includeNew: args.include_new === true,
      });
      return text(envelope({ dir, ...result }));
    }),
  );

  // ==========================================================================
  // Misc (5 tools): link / raw / list_workspaces / set_default_workspace / whoami
  // ==========================================================================

  server.registerTool(
    "link_url_to_issue",
    {
      title: "Attach a URL to an issue (e.g. PR, design doc)",
      description:
        "Creates a Linear Attachment whose target is a URL. Useful for linking PRs. Idempotent at the (issue, url) pair — re-calling with the same url returns the existing attachment with `status: 'already-linked'` (parity with CLI `lebop link`).",
      inputSchema: {
        identifier: z.string(),
        url: z.string(),
        title: z.string().optional().describe("Display title; defaults to the URL itself."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Attach a URL to an issue (e.g. PR, design doc)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const upperId = (args.identifier as string).toUpperCase();
      const fetched = await withClient((c) => c.issue(upperId));
      if (!fetched)
        throw new NotFoundError(
          `issue not found: ${upperId}`,
          `verify ${upperId} exists and is visible to your token`,
        );
      const title = (args.title as string | undefined) ?? (args.url as string);
      let attachment: { id: string; title: string; url: string };
      let status: "linked" | "already-linked" = "linked";
      try {
        const response = (await withClient((c) =>
          c.client.rawRequest(
            /* GraphQL */ `
              mutation AttachURL($issueId: String!, $url: String!, $title: String!) {
                attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
                  success
                  attachment { id title url }
                }
              }
            `,
            { issueId: fetched.id, url: args.url, title },
          ),
        )) as {
          data: {
            attachmentLinkURL: {
              success: boolean;
              attachment: { id: string; title: string; url: string };
            };
          };
        };
        attachment = response.data.attachmentLinkURL.attachment;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already.*linked/i.test(msg)) {
          const existing = await listAttachments(upperId);
          const match = existing.find((a) => a.url === args.url);
          if (!match) throw err;
          attachment = { id: match.id, title: match.title, url: match.url };
          status = "already-linked";
        } else {
          throw err;
        }
      }
      return text(envelope({ identifier: upperId, attachment, status }));
    }),
  );

  server.registerTool(
    "raw_graphql",
    {
      title: "GraphQL escape hatch — execute an arbitrary query/mutation",
      description:
        "Executes any GraphQL query or mutation against Linear's API. Use only when no first-class tool covers the operation. Returns `{schema_version, data}` (the standard MCP envelope wrapping Linear's raw response.data). Pass paginate=true to walk a top-level connection. Caller intent varies per call — treat reads as idempotent, mutations as destructive on the agent's own discretion. The matching CLI tool `lebop raw` intentionally emits unwrapped `data` (no envelope) for jq-pipe ergonomics; see docs/spec.md §15.6.",
      inputSchema: {
        query: z.string().describe("GraphQL document (query or mutation)."),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Variables object for the query."),
        paginate: z
          .boolean()
          .optional()
          .describe(
            "If the query has a top-level connection, walks pageInfo.hasNextPage and merges nodes.",
          ),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "GraphQL escape hatch — execute an arbitrary query/mutation",
        // raw_graphql is intentionally light on annotations — the caller is
        // shaping the GraphQL document so we can't pre-judge readOnly /
        // destructive / idempotent (a `query { viewer }` is harmless, an
        // `issueDelete` mutation is destructive). The MCP host should rely on
        // the caller's intent. We DO assert openWorldHint:true because every
        // raw_graphql call touches an external system (Linear).
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const query = args.query as string;
      const variables = (args.variables as Record<string, unknown> | undefined) ?? {};
      // Round-6 / A18: map GraphQL syntax + validation errors to the
      // structured taxonomy. Pre-fix these landed in `formatToolError`'s
      // unknown-fallback (`code: "unknown"`) which made it impossible for
      // clients to branch on the failure programmatically. Linear's
      // GraphQL endpoint surfaces these as `Syntax Error:` / `Cannot query
      // field` / `Argument Validation Error` messages — wrap them.
      const wrapGqlErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof LebopError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          if (
            /^Syntax Error/.test(msg) ||
            /Cannot query field/.test(msg) ||
            /^Argument Validation Error/.test(msg) ||
            /^Unknown argument/.test(msg) ||
            /^Field .* of type .* must have a selection of subfields/.test(msg)
          ) {
            throw new ValidationError(
              `raw_graphql query failed: ${msg}`,
              "the query is structurally invalid — fix the syntax or schema mismatch and re-send",
            );
          }
          throw err;
        }
      };
      if (!args.paginate) {
        const response = await wrapGqlErrors(
          async () =>
            (await withClient((c) => c.client.rawRequest(query, variables))) as { data: unknown },
        );
        // Intentional CLI/MCP asymmetry: MCP always wraps in the standard
        // {schema_version, data} envelope. The CLI's `lebop raw` emits raw
        // `data` for jq-pipe ergonomics (documented in docs/spec.md §15.6).
        return text(envelope({ data: response.data }));
      }
      // Paginate mode: detect top-level connection by walking response.data.
      type Page = {
        data: Record<
          string,
          { nodes?: unknown[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } }
        >;
      };
      const accumulated: unknown[] = [];
      let connectionKey: string | null = null;
      const nodes = await paginateRaw<unknown, Page>(
        async ({ first, after }) => {
          const merged = { ...variables, first, after };
          return await wrapGqlErrors(
            async () => (await withClient((c) => c.client.rawRequest(query, merged))) as Page,
          );
        },
        (response) => {
          if (!connectionKey) {
            connectionKey =
              Object.keys(response.data).find(
                (k) =>
                  Array.isArray(response.data[k]?.nodes) &&
                  response.data[k]?.pageInfo !== undefined,
              ) ?? null;
          }
          if (!connectionKey) return null;
          const conn = response.data[connectionKey];
          if (!conn?.nodes || !conn.pageInfo) return null;
          return {
            nodes: conn.nodes,
            pageInfo: {
              hasNextPage: conn.pageInfo.hasNextPage,
              endCursor: conn.pageInfo.endCursor,
            },
          };
        },
        { pageSize: 250 },
      );
      accumulated.push(...nodes);
      return text(envelope({ connection: connectionKey, nodes: accumulated }));
    }),
  );

  server.registerTool(
    "list_workspaces",
    {
      title: "List configured Linear workspaces",
      description:
        "Returns ALL workspaces stored in ~/.lebop/auth.json (slug, name, viewer email, default flag). This tool is meta — it lists every workspace lebop knows about and intentionally does NOT accept a `workspace` filter param (unlike every other tool). To inspect a single workspace's viewer / cached profile, call `whoami` with `for_workspace=<slug>` instead.",
      inputSchema: {},
      annotations: {
        title: "List configured Linear workspaces",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async () => {
      const stored = await loadAuth();
      if (!stored) {
        return text(envelope({ workspaces: [], default: null }));
      }
      const slugs = Object.keys(stored.workspaces);
      const workspaces = slugs.map((s) => {
        const ws = stored.workspaces[s];
        return ws
          ? {
              slug: ws.slug,
              name: ws.name,
              url_key: ws.url_key,
              viewer: ws.viewer,
              created_at: ws.created_at,
              is_default: stored.default === s,
            }
          : null;
      });
      return text(
        envelope({
          default: stored.default ?? null,
          workspaces: workspaces.filter(Boolean),
        }),
      );
    }),
  );

  server.registerTool(
    "set_default_workspace",
    {
      title: "Set the default workspace for tool calls without an explicit workspace arg",
      description: "Updates ~/.lebop/auth.json's `default` field.",
      inputSchema: {
        slug: z.string().describe("Workspace slug — must be one already configured."),
      },
      annotations: {
        title: "Set the default workspace for tool calls without an explicit workspace arg",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      await setDefaultWorkspace(args.slug as string);
      return text(envelope({ default: args.slug }));
    }),
  );

  server.registerTool(
    "whoami",
    {
      title: "Current viewer for a workspace",
      description:
        "Returns the cached viewer for `for_workspace` (which auth slug to read) or the current default. Pass `refresh=true` to re-validate against Linear. Two distinct args: `for_workspace` chooses *which auth slug to read*; `workspace` is the universal API-target selector that sets LEBOP_WORKSPACE for this call. Usually they match; the split lets you query one slug while authenticated against another.",
      inputSchema: {
        for_workspace: z
          .string()
          .optional()
          .describe(
            "Auth slug whose cached viewer to return. Defaults to the current default workspace. Renamed from `slug` for clarity vs. the standard `workspace` param.",
          ),
        refresh: z.boolean().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Current viewer for a workspace",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const ws = await loadAuthForWorkspace(args.for_workspace as string | undefined);
      const refresh = args.refresh === true;
      const viewer = refresh ? await validateToken(ws.token) : ws.viewer;
      return text(
        envelope({
          workspace: ws.slug,
          workspace_name: ws.name,
          viewer,
          refreshed: refresh,
          created_at: ws.created_at,
        }),
      );
    }),
  );

  // ---------- cache_gc ----------
  server.registerTool(
    "cache_gc",
    {
      title: "Garbage-collect stale per-repo cache directories",
      description:
        "Scan ~/.lebop/cache/ for per-repo subdirs and report (or remove) stale ones. Defaults to dry-run + preserving the cwd's repo cache. Mirrors `lebop cache gc`.",
      inputSchema: {
        max_age_days: z
          .number()
          .min(0)
          .optional()
          .describe("Evict repos whose newest file is older than N days (default 30)."),
        max_size_mb: z
          .number()
          .min(0)
          .optional()
          .describe("Trim oldest repos until total cache size is below the limit (default 500)."),
        hash: z
          .string()
          .optional()
          .describe("Evict only the named hash; bypasses age/size selection."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Report candidates without removing. Defaults to true."),
        preserve_cwd_repo: z
          .boolean()
          .optional()
          .describe("Skip the cwd's repo cache even if it qualifies. Defaults to true."),
      },
      annotations: {
        title: "Garbage-collect stale per-repo cache directories",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        // cache_gc is purely local-filesystem (~/.lebop/cache) — no Linear
        // API call, no external system touched. `openWorldHint: false` is
        // accurate; `destructiveHint: true` still warns hosts that this
        // tool removes data, and `idempotentHint: false` since each run
        // can evict a different selection (age-based + size-based).
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      const result = await gcCache({
        maxAgeDays: args.max_age_days as number | undefined,
        maxSizeMb: args.max_size_mb as number | undefined,
        hash: args.hash as string | undefined,
        dryRun: args.dry_run === undefined ? true : (args.dry_run as boolean),
        preserveCwdRepo:
          args.preserve_cwd_repo === undefined ? true : (args.preserve_cwd_repo as boolean),
      });
      return text(envelope({ ...result }));
    }),
  );

  // ==========================================================================
  // Wave 4A — attachments, team get, lookups, bulk, workflow states
  // ==========================================================================

  // ---------- attachments ----------
  server.registerTool(
    "list_attachments",
    {
      title: "List attachments on an issue",
      description:
        "Returns all Linear Attachments on one issue (URL links, integration-created references, etc.). Pure read; paginated server-side.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier, e.g. 'NOX-321'."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List attachments on an issue",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const upperId = (args.identifier as string).toUpperCase();
      const attachments = await listAttachments(upperId);
      return text(
        envelope({
          identifier: upperId,
          count: attachments.length,
          attachments,
        }),
      );
    }),
  );

  server.registerTool(
    "update_attachment",
    {
      title: "Update an attachment's title or URL",
      description: "Idempotent at the value level — safe to retry.",
      inputSchema: {
        id: z.string().describe("Attachment UUID."),
        title: z.string().optional(),
        url: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update an attachment's title or URL",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const input: { title?: string; url?: string } = {};
      if (args.title !== undefined) input.title = args.title as string;
      if (args.url !== undefined) input.url = args.url as string;
      if (Object.keys(input).length === 0) {
        throw new ValidationError(
          "nothing to update — pass at least one of title, url",
          "pass title and/or url",
        );
      }
      const attachment = await updateAttachment(args.id as string, input);
      return text(envelope({ attachment }));
    }),
  );

  server.registerTool(
    "delete_attachment",
    {
      title: "Delete an attachment",
      description:
        "Delete an attachment by UUID. Idempotent — re-deleting an already-absent attachment returns `{status: 'already-absent'}`. Round-7 / Q2.",
      inputSchema: {
        id: z.string().describe("Attachment UUID."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete an attachment",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { status } = await tryIdempotentDelete(() => deleteAttachment(args.id as string));
      return text(envelope({ id: args.id, status, success: status === "deleted" }));
    }),
  );

  // ---------- get_team ----------
  server.registerTool(
    "get_team",
    {
      title: "Get one team by key or UUID",
      description:
        "Returns one team (with default-state) or null. Wires the team-key → UUID gap that bites create_label and create_project. `id` accepts a team key (e.g. 'ENG') OR a UUID.",
      inputSchema: {
        id: z.string().describe("Team key (e.g. 'ENG') OR UUID."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one team by key or UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const team = await getTeam(args.id as string);
      return text(envelope({ team }));
    }),
  );

  // ---------- lookups ----------
  server.registerTool(
    "lookup_state_by_name",
    {
      title: "Resolve a workflow state name to a UUID",
      description:
        "Team-scoped exact-name lookup against the Linear workflowStates connection. Case-sensitive. Returns null if not found.",
      inputSchema: {
        team: z.string().describe("Team key (state lookup is team-scoped)."),
        name: z.string().describe("Workflow state name (e.g. 'In Progress'). Case-sensitive."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Resolve a workflow state name to a UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const state = await lookupStateByName(args.team as string, args.name as string);
      return text(envelope({ state }));
    }),
  );

  server.registerTool(
    "lookup_user_by_email",
    {
      title: "Resolve a workspace user by email",
      description: "Returns the user record or null. Useful before assignee=<uuid> updates.",
      inputSchema: {
        email: z.string().describe("Workspace user email. Returns null if not found."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Resolve a workspace user by email",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const user = await lookupUserByEmail(args.email as string);
      return text(envelope({ user }));
    }),
  );

  // ---------- set_workspace_default_team ----------
  server.registerTool(
    "set_workspace_default_team",
    {
      title: "Set the default team for a workspace",
      description:
        "Updates `workspace_team_defaults[<slug>]` in ~/.lebop/config.yaml. Pairs with set_default_workspace. Idempotent at the value level.",
      inputSchema: {
        workspace_slug: z.string().describe("Workspace slug to set the default team for."),
        // Round-6 / C1: renamed from `team_key` → `team` for consistency
        // with every other tool that takes a team identifier (`list_issues`,
        // `list_projects`, `list_team_members`, etc.). Aligns with the
        // round-5 `list_team_members` rename — same rationale.
        team: z.string().describe("Team key (e.g. 'NOX')."),
      },
      annotations: {
        title: "Set the default team for a workspace",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      // Round-11 / M-2: validate that the team exists in the target
      // workspace before writing to config. Pre-fix `set_workspace_default_team
      // {workspace_slug: "X", team: "NOPE"}` silently wrote bogus team keys
      // into `~/.lebop/config.yaml`, surfacing later as confusing
      // "team not found" errors on every subsequent lookup. The check uses
      // the workspace's own auth context (the workspace arg is `workspace_slug`
      // here, NOT the typical `workspace` SDK selector).
      const restore = withWorkspace(args.workspace_slug as string);
      try {
        const team = await getTeam(args.team as string);
        if (!team) {
          throw new NotFoundError(
            `team not found: ${args.team}`,
            `run \`lebop teams --workspace ${args.workspace_slug}\` to list valid keys`,
          );
        }
      } finally {
        restore();
      }
      await setWorkspaceDefaultTeam(args.workspace_slug as string, args.team as string);
      return text(
        envelope({
          workspace_slug: args.workspace_slug,
          // Response envelope also uses `team` (not `team_key`) — same
          // consistency principle. BREAKING for any caller that read
          // response.team_key; the wire-level rename is the whole point.
          team: args.team,
        }),
      );
    }),
  );

  // ---------- bulk_update_issues ----------
  server.registerTool(
    "bulk_update_issues",
    {
      title: "Apply one patch uniformly to N issues",
      description:
        "Wraps Linear's issueBatchUpdate. Resolves all extras (state/labels/assignee/project/milestone/cycle names → UUIDs) ONCE up front, then fires a single batch mutation. Returns partial-success per-row results matching push_changes' shape: each input identifier maps to either {status:'updated', fields} or {status:'failed', error:{code, message, hint}}. Idempotent at the value level.",
      inputSchema: {
        identifiers: z.array(z.string()).describe("Issue identifiers (TEAM-NN) to update."),
        patch: z
          .object({
            state: z.string().optional(),
            priority: z.union([z.string(), z.number()]).optional(),
            labels: z.array(z.string()).optional(),
            assignee: z.union([z.string(), z.null()]).optional(),
            estimate: z.union([z.number(), z.null()]).optional(),
            project: z.union([z.string(), z.null()]).optional(),
            milestone: z.union([z.string(), z.null()]).optional(),
            cycle: z.union([z.string(), z.null()]).optional(),
          })
          .describe("Patch to apply uniformly to each issue."),
        team: z
          .string()
          .optional()
          .describe(
            "Override team for state/labels resolution; otherwise derived from identifier prefix.",
          ),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Apply one patch uniformly to N issues",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const result = await bulkUpdateIssues({
        identifiers: args.identifiers as string[],
        patch: args.patch as Parameters<typeof bulkUpdateIssues>[0]["patch"],
        team: args.team as string | undefined,
      });
      return text(envelope({ results: result.results, summary: result.summary }));
    }),
  );

  // ---------- list_workflow_states ----------
  server.registerTool(
    "list_workflow_states",
    {
      title: "List workflow states for a team",
      description:
        "Per-team workflow states (Backlog, Todo, In Progress, Done, Cancelled — varies per team setup). Thin wrapper over the team-metadata cache + a live states() fetch for color + default flag.",
      inputSchema: {
        team: z.string().describe("Team key."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List workflow states for a team",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const result = await listWorkflowStates(args.team as string);
      if (!result) {
        throw new NotFoundError(`team not found: ${args.team}`, "verify the team key (e.g. 'NOX')");
      }
      return text(
        envelope({ team: result.team, count: result.states.length, states: result.states }),
      );
    }),
  );
}

/**
 * Set LEBOP_WORKSPACE for the duration of this tool call so the existing
 * `loadAuthForWorkspace` env-var path picks it up. The cached LinearClient
 * map is keyed by slug, so per-workspace selection works correctly.
 *
 * Returns a restore function; callers must invoke it in a `finally` to
 * avoid sticky state across tool calls (request A with workspace=foo
 * shouldn't leak `foo` into request B that doesn't pass `workspace`).
 *
 * The stdio MCP transport processes requests serially, so this isn't a
 * concurrency hazard within one connection — but the cross-call leak is
 * a real bug independent of concurrency.
 *
 * Round-6 / L3 comment-pin: when the MCP server gains an HTTP+SSE
 * transport (see file header), this env-mutation pattern WILL race
 * across concurrent tool calls. Replace with an async-local-storage /
 * AsyncContext-scoped workspace before flipping that switch.
 */
function withWorkspace(workspace: string | undefined): () => void {
  const prev = process.env.LEBOP_WORKSPACE;
  if (workspace) process.env.LEBOP_WORKSPACE = workspace;
  return () => {
    if (prev === undefined) {
      // env vars need real delete; setting to undefined would coerce
      // to the string "undefined".
      delete process.env.LEBOP_WORKSPACE;
    } else {
      process.env.LEBOP_WORKSPACE = prev;
    }
  };
}

/**
 * Wrap an MCP tool handler so any thrown error becomes a structured
 * `{content, isError: true}` response with `LebopError.code` + `hint`
 * preserved. The MCP SDK's default catch path serializes only
 * `error.message`, dropping the structured taxonomy this codebase took
 * pains to build (spec §13.3 promises the contract).
 *
 * Also handles per-call `workspace` selection: applies the override before
 * the handler runs and restores the prior `LEBOP_WORKSPACE` env in the
 * `finally` block. Prevents one tool call from leaking its workspace
 * into the next.
 */
type ToolHandlerArgs = Record<string, unknown>;
type ToolHandlerResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Replace the MCP SDK's default `CallToolRequestSchema` handler with one
 * that emits the structured envelope on input-validation failure.
 *
 * Background (round-6 / H11): `@modelcontextprotocol/sdk@1.29` validates
 * tool input inside `McpServer.validateToolInput` BEFORE invoking the
 * user-provided handler. On failure it throws `McpError(InvalidParams)`,
 * which the SDK's outer try/catch routes through `createToolError(message)`
 * to produce a prose payload (`"MCP error -32602: Input validation error: ..."`).
 * That bypasses our envelope contract — clients that want to branch on
 * `error.code` can't, because the payload is a free-form string.
 *
 * The SDK exposes no validation-error hook, no middleware, and no
 * `onError` callback (verified in agent investigation). The only viable
 * intercept point is to overwrite the protocol-layer request handler via
 * `server.server.setRequestHandler(...)` AFTER `registerTools()` has run
 * (which is when the SDK lazily installs its default handler). We reuse
 * the SDK's own `normalizeObjectSchema` + `safeParseAsync` helpers so the
 * validation semantics match exactly — only the error-format step changes.
 *
 * Lebop doesn't use `outputSchema` or `taskSupport`; those SDK paths are
 * intentionally omitted here to keep the override surgical. If a future
 * tool needs them, mirror the SDK's `mcp.js:100-143` logic into this
 * handler.
 */
function installEnvelopeValidator(server: McpServer): void {
  // `_registeredTools` is declared `private` in the SDK types but is a
  // plain JS field at runtime. Cast via `unknown` to silence TS without
  // weakening the rest of `server`'s type. The shape matches the SDK's
  // internal RegisteredTool interface (only the fields we read are typed).
  type RegisteredTool = {
    enabled?: boolean;
    inputSchema?: unknown;
    // Round-8 backlog / N3: only read for the fail-fast assert below.
    // Our overridden CallToolRequestSchema handler intentionally skips the
    // SDK's outputSchema-validation branch; if a future tool ever registers
    // an outputSchema, that validation would silently NOT fire. The assert
    // makes that scenario fail at boot instead of in production.
    outputSchema?: unknown;
    execution?: { taskSupport?: string };
    handler: (args: unknown, extra: unknown) => Promise<ToolHandlerResult>;
  };
  const registry = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;

  // Round-8 backlog / N3: fail-fast guard. The handler we register below
  // intentionally doesn't replicate the SDK's `validateToolOutput` or
  // task-aware branches (no lebop tool uses them today). If anyone adds
  // a tool with `outputSchema` or active `taskSupport` later, we want a
  // clear boot-time error pointing at this assert rather than silent
  // skips. NOTE: `taskSupport === "forbidden"` is the SDK's default for
  // tools that explicitly opt OUT of task augmentation — that's safe to
  // skip; only "required" and "optional" indicate task-aware tools.
  for (const [name, tool] of Object.entries(registry)) {
    if (tool.outputSchema !== undefined) {
      throw new Error(
        `installEnvelopeValidator: tool "${name}" has an outputSchema, but the envelope validator does not replicate the SDK's output-validation branch. Mirror it from @modelcontextprotocol/sdk/server/mcp.js:185-207 before adding outputSchema-bearing tools.`,
      );
    }
    const taskSupport = tool.execution?.taskSupport;
    if (taskSupport === "required" || taskSupport === "optional") {
      throw new Error(
        `installEnvelopeValidator: tool "${name}" has taskSupport="${taskSupport}", but the envelope validator does not replicate the SDK's task-handler branches. Mirror them from @modelcontextprotocol/sdk/server/mcp.js:109-122 before adding task-aware tools.`,
      );
    }
  }

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = request.params.arguments;

    const tool = registry[name];
    if (!tool) {
      return envelopeError("not_found", `Tool ${name} not found`);
    }
    if (tool.enabled === false) {
      return envelopeError("validation_error", `Tool ${name} is disabled`);
    }

    // Validate input ourselves — mirrors SDK validateToolInput logic so
    // the tools/list-emitted JSON Schema (clients use it for autocomplete +
    // type hints) stays the same. Only the failure-path payload changes.
    // The zod-compat helpers accept a fuzzy `AnySchema | ZodRawShapeCompat`
    // union; our `tool.inputSchema` is `unknown` from the registry cast.
    // Trust the SDK's invariant (it ran these same helpers without issue
    // before we overwrote the handler) and cast via `as never`.
    let parsedArgs: unknown = args;
    if (tool.inputSchema !== undefined) {
      const inputObj = normalizeObjectSchema(tool.inputSchema as never);
      const schemaToParse = inputObj ?? (tool.inputSchema as never);
      const parseResult = await safeParseAsync(schemaToParse, args);
      if (!parseResult.success) {
        const errObj = (parseResult as { error?: { issues?: unknown } }).error;
        const issues = Array.isArray(errObj?.issues) ? errObj.issues : [];
        const err = new InvalidArgumentsError(
          `Invalid arguments for tool ${name}`,
          issues,
          "see `issues` for per-field detail (path + zod issue code + expected vs received)",
        );
        return {
          content: [{ type: "text", text: formatToolError(err) }],
          isError: true,
        };
      }
      parsedArgs = parseResult.data;

      // Round-7 / Q3: enforce strict-mode globally via a post-validation
      // key-set check. The MCP SDK's `normalizeObjectSchema` returns
      // v4-mini object schemas for raw-shape inputs (which lebop uses
      // everywhere), and v4-mini doesn't expose a chainable `.strict()`
      // method. Post-validation key comparison is the simplest robust
      // alternative: any key in `args` that didn't survive into
      // `parseResult.data` was silently stripped by zod (typo, wrong
      // singular/plural, forward-compat probe). Emit the same
      // `invalid_arguments` envelope shape as native zod rejections so
      // clients can branch uniformly. Closes MCP smoke H-MCP-1.
      if (
        typeof args === "object" &&
        args !== null &&
        !Array.isArray(args) &&
        typeof parsedArgs === "object" &&
        parsedArgs !== null
      ) {
        const inputKeys = Object.keys(args as Record<string, unknown>);
        const parsedKeys = new Set(Object.keys(parsedArgs as Record<string, unknown>));
        const unrecognized = inputKeys.filter((k) => !parsedKeys.has(k));
        if (unrecognized.length > 0) {
          const keysList = unrecognized.map((k) => `"${k}"`).join(", ");
          const err = new InvalidArgumentsError(
            `Invalid arguments for tool ${name}: unrecognized ${unrecognized.length > 1 ? "keys" : "key"} ${keysList}`,
            [
              {
                code: "unrecognized_keys",
                keys: unrecognized,
                path: [],
                message: `Unrecognized ${unrecognized.length > 1 ? "keys" : "key"}: ${keysList}`,
              },
            ],
            "remove the listed keys (they're not in the tool's input schema). Check for typos / wrong singular-vs-plural.",
          );
          return {
            content: [{ type: "text", text: formatToolError(err) }],
            isError: true,
          };
        }
      }
    }

    // Delegate to the registered handler. Every tool is wrapped via our
    // `safe()` helper at registration time, so business-rule errors flow
    // through `formatToolError` and emit the envelope. This defensive
    // try/catch handles only the impossible-shouldn't-happen cases (an
    // unwrapped handler, an SDK-task-handler shape we don't use today).
    try {
      return await tool.handler(parsedArgs, extra);
    } catch (err) {
      return {
        content: [{ type: "text", text: formatToolError(err) }],
        isError: true,
      };
    }
  });
}

function envelopeError(code: string, message: string, hint?: string): ToolHandlerResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            schema_version: SCHEMA_VERSION,
            error: { code, message, ...(hint ? { hint } : {}) },
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

function safe<A extends ToolHandlerArgs>(
  fn: (args: A) => Promise<ToolHandlerResult>,
): (args: A) => Promise<ToolHandlerResult> {
  return async (args) => {
    const restore = withWorkspace(args.workspace as string | undefined);
    try {
      return await fn(args);
    } catch (err) {
      return {
        content: [{ type: "text", text: formatToolError(err) }],
        isError: true,
      };
    } finally {
      restore();
    }
  };
}

/**
 * Wrap any JSON-serializable payload as an MCP tool-call response with a
 * single text content block. Keeps the registered tools terse.
 */
function text(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Format a thrown error as an MCP tool-call response. LebopError surfaces
 * its code + hint; everything else falls through to the message.
 */
export function formatToolError(err: unknown): string {
  if (err instanceof LebopError) {
    // InvalidArgumentsError carries a structured `issues` array (round-6 / H11)
    // so clients can branch precisely on per-field failures from the JSON-RPC
    // validation layer. Surface it on the envelope when present; omit for
    // other LebopError subtypes that don't carry issues.
    const issues =
      err instanceof InvalidArgumentsError && err.issues.length > 0 ? err.issues : undefined;
    return JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        error: {
          code: err.code,
          message: err.message,
          hint: err.hint,
          ...(issues ? { issues } : {}),
        },
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      schema_version: SCHEMA_VERSION,
      error: { code: "unknown", message: (err as Error).message ?? String(err) },
    },
    null,
    2,
  );
}
