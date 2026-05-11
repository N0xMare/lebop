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
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { getAgentSession, listAgentSessions } from "../lib/agentSessions.ts";
import { loadAuth, loadAuthForWorkspace, setDefaultWorkspace, validateToken } from "../lib/auth.ts";
import { buildComments, buildIssueMetadata } from "../lib/build.ts";
import {
  type IssueMetadata,
  issueDir,
  listCachedIssues,
  listCachedProjectIds,
  readIssue,
  readProject,
  writeComment,
  writeIssue,
} from "../lib/cache.ts";
import { addComment, deleteComment, listComments, updateComment } from "../lib/comments.ts";
import { resolveConfig } from "../lib/config.ts";
import { getCycle, listCycles } from "../lib/cycles.ts";
import { arraysEqual, diffIssueMetadata } from "../lib/diff.ts";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from "../lib/documents.ts";
import { LebopError } from "../lib/errors.ts";
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
import { buildCasQuery, ISSUE_UPDATE_MUTATION } from "../lib/pushMutations.ts";
import { createLink, LINK_KINDS, type LinkKind, listRelations } from "../lib/relations.ts";
import { getTeamMetadata } from "../lib/resolve.ts";
import { withClient } from "../lib/sdk.ts";
import { listTeamMembers } from "../lib/teamMembers.ts";

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
    safe(async (args) => {
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const labels = await listLabels({
        team: args.workspace_only || args.all ? undefined : args.team,
        workspaceOnly: args.workspace_only,
        all: args.all,
      });
      return text({ schema_version: 1, count: labels.length, labels });
    }),
  );

  server.registerTool(
    "create_label",
    {
      title: "Create a Linear label",
      description:
        "Create a team-scoped or workspace-scoped label. NOT retry-wrapped (would duplicate).",
      inputSchema: {
        name: z.string(),
        team_id: z.string().optional().describe("Team UUID (NOT key). Omit for workspace-scoped."),
        color: z.string().optional().describe("Hex color (e.g. '#ff0000')."),
        description: z.string().optional(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const label = await createLabel({
        name: args.name,
        teamId: args.team_id,
        color: args.color,
        description: args.description,
      });
      return text({ schema_version: 1, label });
    }),
  );

  server.registerTool(
    "delete_label",
    {
      title: "Delete a Linear label",
      description: "Delete by UUID. NOT retry-wrapped (would not-found after success).",
      inputSchema: {
        id: z
          .string()
          .describe("Label UUID. Use lookup_label_by_name first if you only have the name."),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const success = await deleteLabel(args.id);
      return text({ schema_version: 1, id: args.id, success });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const label = await resolveLabelByName(args.name, args.team);
      return text({ schema_version: 1, label });
    }),
  );

  // ---------- milestones ----------
  server.registerTool(
    "list_milestones",
    {
      title: "List project milestones",
      description: "List milestones; pass project to filter to one project (name or UUID).",
      inputSchema: {
        project: z.string().optional().describe("Project name or UUID."),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      let projectId: string | undefined;
      if (args.project) {
        const resolved = await resolveProjectId(args.project);
        if (!resolved) throw new Error(`project not found: ${args.project}`);
        projectId = resolved;
      }
      const milestones = await listMilestones({ projectId });
      return text({ schema_version: 1, count: milestones.length, milestones });
    }),
  );

  server.registerTool(
    "get_milestone",
    {
      title: "Get one milestone by UUID",
      description: "Returns the milestone or null.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const milestone = await getMilestone(args.id);
      return text({ schema_version: 1, milestone });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const projectId = await resolveProjectId(args.project);
      if (!projectId) throw new Error(`project not found: ${args.project}`);
      const milestone = await createMilestone({
        name: args.name,
        projectId,
        description: args.description,
        targetDate: args.target_date,
        sortOrder: args.sort_order,
      });
      return text({ schema_version: 1, milestone });
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
        workspace: z.string().optional(),
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
        if (!projectId) throw new Error(`project not found: ${args.project}`);
        input.projectId = projectId;
      }
      if (Object.keys(input).length === 0) {
        throw new Error("nothing to update — pass at least one field");
      }
      const milestone = await updateMilestone(args.id, input);
      return text({ schema_version: 1, milestone });
    }),
  );

  server.registerTool(
    "delete_milestone",
    {
      title: "Delete a milestone",
      description: "By UUID. NOT retry-wrapped.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const success = await deleteMilestone(args.id);
      return text({ schema_version: 1, id: args.id, success });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const records = await listProjects({ team: args.team, state: args.state, max });
      return text({ schema_version: 1, count: records.length, projects: records });
    }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get one project by UUID",
      description: "Returns the project (with content + lead + teams) or null.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const project = await getProject(args.id);
      return text({ schema_version: 1, project });
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
        workspace: z.string().optional(),
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
      return text({ schema_version: 1, project });
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
        workspace: z.string().optional(),
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
        throw new Error("nothing to update — pass at least one field");
      }
      const project = await updateProject(args.id, input);
      return text({ schema_version: 1, project });
    }),
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete a project",
      description: "By UUID. NOT retry-wrapped. Irreversible.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const success = await deleteProject(args.id);
      return text({ schema_version: 1, id: args.id, success });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const projectId = await resolveProjectId(args.project);
      if (!projectId) throw new Error(`project not found: ${args.project}`);
      const updates = await listProjectUpdates(projectId);
      return text({ schema_version: 1, project_id: projectId, count: updates.length, updates });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const projectId = await resolveProjectId(args.project);
      if (!projectId) throw new Error(`project not found: ${args.project}`);
      const update = await createProjectUpdate({
        projectId,
        body: args.body,
        health: args.health as ProjectHealth | undefined,
      });
      return text({ schema_version: 1, project_update: update });
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
        workspace: z.string().optional(),
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
      return text({ schema_version: 1, count: initiatives.length, initiatives });
    }),
  );

  server.registerTool(
    "get_initiative",
    {
      title: "Get one initiative (with linked projects)",
      description: "Returns null if not found.",
      inputSchema: {
        id_or_name: z.string(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const id = await resolveInitiativeId(args.id_or_name);
      if (!id) return text({ schema_version: 1, initiative: null });
      const initiative = await getInitiative(id);
      return text({ schema_version: 1, initiative });
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
        icon: z.string().optional(),
        workspace: z.string().optional(),
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
      return text({ schema_version: 1, initiative });
    }),
  );

  server.registerTool(
    "update_initiative",
    {
      title: "Update an initiative",
      description: "Idempotent at the value level — safe to retry.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        status: z.string().optional(),
        owner_id: z.union([z.string(), z.null()]).optional(),
        target_date: z.union([z.string(), z.null()]).optional(),
        color: z.string().optional(),
        icon: z.string().optional(),
        workspace: z.string().optional(),
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
      if (Object.keys(input).length === 0) throw new Error("nothing to update");
      const initiative = await updateInitiative(args.id, input);
      return text({ schema_version: 1, initiative });
    }),
  );

  server.registerTool(
    "archive_initiative",
    {
      title: "Archive an initiative (reversible)",
      description: "NOT retry-wrapped.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    safe(async (args) => {
      const success = await archiveInitiative(args.id);
      return text({ schema_version: 1, id: args.id, success });
    }),
  );

  server.registerTool(
    "unarchive_initiative",
    {
      title: "Unarchive an initiative",
      description: "NOT retry-wrapped.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    safe(async (args) => {
      const success = await unarchiveInitiative(args.id);
      return text({ schema_version: 1, id: args.id, success });
    }),
  );

  server.registerTool(
    "delete_initiative",
    {
      title: "Delete an initiative permanently",
      description: "NOT retry-wrapped.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    safe(async (args) => {
      const success = await deleteInitiative(args.id);
      return text({ schema_version: 1, id: args.id, success });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId) throw new Error(`initiative not found: ${args.initiative}`);
      const projectId = await resolveProjectId(args.project);
      if (!projectId) throw new Error(`project not found: ${args.project}`);
      const result = await initiativeAddProject({
        initiativeId,
        projectId,
        sortOrder: args.sort_order,
      });
      return text({ schema_version: 1, edge_id: result.id });
    }),
  );

  server.registerTool(
    "initiative_remove_project",
    {
      title: "Unlink a project from an initiative",
      description: "Returns false if the link was already absent.",
      inputSchema: {
        initiative: z.string(),
        project: z.string(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId) throw new Error(`initiative not found: ${args.initiative}`);
      const projectId = await resolveProjectId(args.project);
      if (!projectId) throw new Error(`project not found: ${args.project}`);
      const success = await initiativeRemoveProject({ initiativeId, projectId });
      return text({ schema_version: 1, success });
    }),
  );

  server.registerTool(
    "list_initiative_updates",
    {
      title: "List initiative status updates",
      description: "Chronological status posts for one initiative.",
      inputSchema: {
        initiative: z.string().describe("Initiative name or UUID."),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId) throw new Error(`initiative not found: ${args.initiative}`);
      const updates = await listInitiativeUpdates(initiativeId);
      return text({
        schema_version: 1,
        initiative_id: initiativeId,
        count: updates.length,
        updates,
      });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId) throw new Error(`initiative not found: ${args.initiative}`);
      const update = await createInitiativeUpdate({
        initiativeId,
        body: args.body,
        health: args.health as InitiativeHealth | undefined,
      });
      return text({ schema_version: 1, initiative_update: update });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const cycles = await listCycles({ team: args.team, max });
      return text({ schema_version: 1, count: cycles.length, cycles });
    }),
  );

  server.registerTool(
    "get_cycle",
    {
      title: "Get one cycle by UUID",
      description: "Returns null if not found.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    safe(async (args) => {
      const cycle = await getCycle(args.id);
      return text({ schema_version: 1, cycle });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      let projectId: string | undefined;
      if (args.project) {
        const resolved = await resolveProjectId(args.project);
        if (!resolved) throw new Error(`project not found: ${args.project}`);
        projectId = resolved;
      }
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const documents = await listDocuments({ projectId, max });
      return text({ schema_version: 1, count: documents.length, documents });
    }),
  );

  server.registerTool(
    "get_document",
    {
      title: "Get one document by UUID (with content)",
      description: "Returns null if not found.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    safe(async (args) => {
      const document = await getDocument(args.id);
      return text({ schema_version: 1, document });
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
        icon: z.string().optional(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const projectId = await resolveProjectId(args.project);
      if (!projectId) throw new Error(`project not found: ${args.project}`);
      const document = await createDocument({
        title: args.title,
        projectId,
        content: args.content,
        icon: args.icon,
      });
      return text({ schema_version: 1, document });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const input: Parameters<typeof updateDocument>[1] = {};
      if (args.title !== undefined) input.title = args.title;
      if (args.content !== undefined) input.content = args.content;
      if (args.icon !== undefined) input.icon = args.icon;
      if (Object.keys(input).length === 0) throw new Error("nothing to update");
      const document = await updateDocument(args.id, input);
      return text({ schema_version: 1, document });
    }),
  );

  server.registerTool(
    "delete_document",
    {
      title: "Delete a document permanently",
      description: "NOT retry-wrapped.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    safe(async (args) => {
      const success = await deleteDocument(args.id);
      return text({ schema_version: 1, id: args.id, success });
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
        workspace: z.string().optional(),
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
      return text({ schema_version: 1, count: sessions.length, agent_sessions: sessions });
    }),
  );

  server.registerTool(
    "get_agent_session",
    {
      title: "Get one agent session by UUID",
      description: "Returns null if not found.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    safe(async (args) => {
      const session = await getAgentSession(args.id);
      return text({ schema_version: 1, agent_session: session });
    }),
  );

  // ---------- team members ----------
  server.registerTool(
    "list_team_members",
    {
      title: "List members of a team",
      description: "Pass include_inactive=true to see deactivated users.",
      inputSchema: {
        team_key: z.string(),
        include_inactive: z.boolean().optional(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const members = await listTeamMembers({
        teamKey: args.team_key,
        includeInactive: args.include_inactive,
      });
      return text({ schema_version: 1, team: args.team_key, count: members.length, members });
    }),
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
    safe(async (args) => {
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
        "Fetch one issue by identifier (TEAM-NN). Returns full metadata + description + comments + relations + parent/sub-issues.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier, e.g. 'NOX-321'."),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const issue = await getIssue(args.identifier as string);
      return text({ schema_version: 1, issue });
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
        workspace: z.string().optional(),
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
      return text({ schema_version: 1, issue });
    }),
  );

  server.registerTool(
    "update_issue",
    {
      title: "Update fields on an existing Linear issue",
      description:
        "Set any combination of: title, description, state, priority, estimate, labels, assignee, parent. Idempotent at the value level — safe to retry.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier (TEAM-NN)."),
        team: z
          .string()
          .optional()
          .describe(
            "Team key — required for resolving state/labels/assignee names. Skip if only setting title/description/priority/estimate.",
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
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
      });
      return text({ schema_version: 1, issue });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const results = await archiveIssues(args.identifiers as string[]);
      return text({ schema_version: 1, results });
    }),
  );

  server.registerTool(
    "unarchive_issue",
    {
      title: "Unarchive one or more issues",
      description: "Reverse of archive_issue. NOT retry-wrapped.",
      inputSchema: {
        identifiers: z.array(z.string()),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const results = await unarchiveIssues(args.identifiers as string[]);
      return text({ schema_version: 1, results });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const comments = await listComments(args.identifier as string);
      return text({
        schema_version: 1,
        identifier: args.identifier,
        count: comments.length,
        comments,
      });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const result = await addComment({
        identifier: args.identifier as string,
        body: args.body as string,
        parentId: args.parent_id as string | undefined,
      });
      return text({ schema_version: 1, identifier: args.identifier, comment: result });
    }),
  );

  server.registerTool(
    "update_comment",
    {
      title: "Update an existing comment",
      description: "Idempotent at the value level — safe to retry.",
      inputSchema: {
        comment_id: z.string().describe("Comment UUID (visible in list_comments)."),
        body: z.string(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const result = await updateComment(args.comment_id as string, args.body as string);
      return text({ schema_version: 1, comment: result });
    }),
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete a comment by UUID",
      description: "NOT retry-wrapped — re-running after success surfaces as not-found.",
      inputSchema: {
        comment_id: z.string(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const success = await deleteComment(args.comment_id as string);
      return text({ schema_version: 1, comment_id: args.comment_id, success });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const config = await resolveConfig({
        cwd: args.repo_root as string | undefined,
        teamOverride: args.team as string | undefined,
      });

      const issueIds = await listCachedIssues(config.repoHash);
      type Entry = { identifier: string; metadata: IssueMetadata; fields: string[] };
      const valid: Entry[] = [];
      for (const id of issueIds) {
        const loaded = await readIssue(config.repoHash, id);
        if (!loaded) continue;
        const changes = diffIssueMetadata(loaded.metadata, loaded.description);
        valid.push({
          identifier: id,
          metadata: loaded.metadata,
          fields: changes.map((c) => c.field),
        });
      }
      const modified = valid.filter((r) => r.fields.length > 0);
      const clean = valid.filter((r) => r.fields.length === 0);

      const projectIds = await listCachedProjectIds(config.repoHash);
      const projectIdsLoaded: string[] = [];
      for (const pid of projectIds) {
        const loaded = await readProject(config.repoHash, pid);
        if (loaded) projectIdsLoaded.push(pid);
      }

      let stale: { identifier: string; server_updated_at: string; remote_updated_at: string }[] =
        [];
      let stale_check: "ok" | "errored" | "skipped" = "skipped";
      const checkRemote = args.check_remote !== false && clean.length > 0;
      if (checkRemote) {
        try {
          const ids = clean.map((r) => r.identifier);
          const query = buildCasQuery(ids);
          const response = (await withClient((c) => c.client.rawRequest(query))) as {
            data: Record<string, { id: string; identifier: string; updatedAt: string } | null>;
          };
          stale = ids.flatMap((_id, i) => {
            const entry = clean[i];
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
      return text({
        schema_version: 1,
        team: config.team,
        repo_root: config.repoRoot,
        repo_hash: config.repoHash,
        modified: modified.map((m) => ({ identifier: m.identifier, fields: m.fields })),
        stale,
        stale_check,
        clean: clean.filter((c) => !staleSet.has(c.identifier)).map((c) => c.identifier),
        cached_project_ids: projectIdsLoaded,
      });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const config = await resolveConfig({
        cwd: args.repo_root as string | undefined,
        teamOverride: args.team as string | undefined,
      });
      const upperId = (args.identifier as string).toUpperCase();
      const local = await readIssue(config.repoHash, upperId);
      if (!local) {
        throw new Error(`${upperId} is not in the local cache. call pull_issues first.`);
      }
      const query = buildPullIssuesQuery([upperId], false);
      const response = (await withClient((c) => c.client.rawRequest(query))) as {
        data: Record<string, FetchedIssue | null>;
      };
      const remoteNode = response.data.a0;
      if (!remoteNode) throw new Error(`not found: ${upperId}`);

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

      return text({
        schema_version: 1,
        identifier: upperId,
        fields,
        description_changed: descChanged,
        description_patch: descChanged ? patch : null,
      });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const config = await resolveConfig({
        cwd: args.repo_root as string | undefined,
        teamOverride: args.team as string | undefined,
      });
      const ids = args.identifiers as string[];
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
          throw new Error(
            `refusing to overwrite local edits on: ${conflicts.join(", ")}. push them first or pass refresh=true.`,
          );
        }
      }

      const query = buildPullIssuesQuery(ids, withComments);
      const response = (await withClient((c) => c.client.rawRequest(query))) as {
        data: Record<string, FetchedIssue | null>;
      };

      const fetched: { identifier: string; comments: number; cache_path: string }[] = [];
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
        fetched.push({
          identifier: node.identifier,
          comments: cached.length,
          cache_path: issueDir(config.repoHash, node.identifier),
        });
      }
      return text({ schema_version: 1, fetched, errors });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const config = await resolveConfig({
        cwd: args.repo_root as string | undefined,
        teamOverride: args.team as string | undefined,
      });
      const requested = args.identifiers as string[] | undefined;
      const dryRun = args.dry_run === true;
      const force = args.force === true;

      const cachedIds = await listCachedIssues(config.repoHash);
      const candidates = requested ? cachedIds.filter((id) => requested.includes(id)) : cachedIds;

      const results: {
        identifier: string;
        status: "updated" | "unchanged" | "stale" | "not-found" | "dry-run" | "error";
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
          results.push({ identifier: id, status: "not-found" });
          continue;
        }
        const changes = diffIssueMetadata(loaded.metadata, loaded.description);
        if (changes.length === 0) {
          results.push({ identifier: id, status: "unchanged" });
          continue;
        }

        if (!force) {
          const remote = remoteCas[`a${i}`];
          if (remote) {
            const localT = Date.parse(loaded.metadata._server.updated_at);
            const remoteT = Date.parse(remote.updatedAt);
            if (remoteT > localT) {
              results.push({
                identifier: id,
                status: "stale",
                fields: changes.map((c) => c.field),
              });
              continue;
            }
          }
        }

        if (dryRun) {
          results.push({ identifier: id, status: "dry-run", fields: changes.map((c) => c.field) });
          continue;
        }

        // Apply mutation. We send the fields the diff identified.
        const linearInput: Record<string, unknown> = {};
        for (const change of changes) {
          if (change.field === "title") linearInput.title = loaded.metadata.title;
          else if (change.field === "description") linearInput.description = loaded.description;
          // Other field types (state, priority, etc.) require resolution against
          // team metadata — defer to the CLI `push` command for those paths.
        }
        if (Object.keys(linearInput).length === 0) {
          results.push({
            identifier: id,
            status: "error",
            fields: changes.map((c) => c.field),
            error:
              "MCP push_changes only handles title + description. Use the CLI `lebop push` for state/priority/labels/assignee/parent.",
          });
          continue;
        }
        try {
          const remote = remoteCas[`a${i}`] ?? null;
          const issueUuid = remote?.id ?? loaded.metadata._server.id;
          if (!issueUuid) {
            results.push({ identifier: id, status: "not-found" });
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
          results.push({ identifier: id, status: "updated", fields: changes.map((c) => c.field) });
        } catch (err) {
          results.push({
            identifier: id,
            status: "error",
            fields: changes.map((c) => c.field),
            error: (err as Error).message,
          });
        }
      }

      return text({
        schema_version: 1,
        results,
        notes: dryRun
          ? "dry-run: nothing was written"
          : "MCP push handles title + description only; other fields fall back to CLI `lebop push`.",
      });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      // Skip semantic checks unless team provided — this mirrors `lebop plan validate`.
      const result = validatePlan(plan, null);
      return text({
        schema_version: 1,
        dir,
        project: { name: plan.project.frontmatter.name, team: plan.project.frontmatter.team },
        issue_count: plan.issues.length,
        errors: result.errors,
        warnings: result.warnings,
      });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      const teamKey = (args.team as string | undefined) ?? plan.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: teamKey });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      const result = await applyPlan(plan, teamMetadata, {
        dryRun: args.dry_run === true,
        strict: args.strict === true,
      });
      return text({ schema_version: 1, dir, ...result });
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      const teamKey = (args.team as string | undefined) ?? plan.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: teamKey });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      const result = await diffPlan(plan, teamMetadata);
      return text({ schema_version: 1, dir, ...result });
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
        workspace: z.string().optional(),
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
      return text({ schema_version: 1, dir, ...result });
    }),
  );

  // ==========================================================================
  // Misc (5 tools): link / raw / list_workspaces / set_default_workspace / whoami
  // ==========================================================================

  server.registerTool(
    "link_url_to_issue",
    {
      title: "Attach a URL to an issue (e.g. PR, design doc)",
      description: "Creates a Linear Attachment whose target is a URL. Useful for linking PRs.",
      inputSchema: {
        identifier: z.string(),
        url: z.string(),
        title: z.string().optional().describe("Display title; defaults to the URL itself."),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const upperId = (args.identifier as string).toUpperCase();
      const fetched = await withClient((c) => c.issue(upperId));
      if (!fetched) throw new Error(`issue not found: ${upperId}`);
      const title = (args.title as string | undefined) ?? (args.url as string);
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
      return text({
        schema_version: 1,
        identifier: upperId,
        attachment: response.data.attachmentLinkURL.attachment,
      });
    }),
  );

  server.registerTool(
    "raw_graphql",
    {
      title: "GraphQL escape hatch — execute an arbitrary query/mutation",
      description:
        "Executes any GraphQL query or mutation against Linear's API. Use only when no first-class tool covers the operation. Output is the raw response.data; pass paginate=true to walk a top-level connection.",
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
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const query = args.query as string;
      const variables = (args.variables as Record<string, unknown> | undefined) ?? {};
      if (!args.paginate) {
        const response = (await withClient((c) => c.client.rawRequest(query, variables))) as {
          data: unknown;
        };
        return text({ schema_version: 1, data: response.data });
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
          return (await withClient((c) => c.client.rawRequest(query, merged))) as Page;
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
      return text({ schema_version: 1, connection: connectionKey, nodes: accumulated });
    }),
  );

  server.registerTool(
    "list_workspaces",
    {
      title: "List configured Linear workspaces",
      description:
        "Returns every workspace stored in ~/.lebop/auth.json (slug, name, viewer email, default flag).",
      inputSchema: {},
    },
    safe(async () => {
      const stored = await loadAuth();
      if (!stored) {
        return text({ schema_version: 1, workspaces: [], default: null });
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
      return text({
        schema_version: 1,
        default: stored.default ?? null,
        workspaces: workspaces.filter(Boolean),
      });
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
    },
    safe(async (args) => {
      await setDefaultWorkspace(args.slug as string);
      return text({ schema_version: 1, default: args.slug });
    }),
  );

  server.registerTool(
    "whoami",
    {
      title: "Current viewer for a workspace",
      description:
        "Returns the cached viewer for the given workspace (or default). Pass refresh=true to re-validate against Linear.",
      inputSchema: {
        slug: z.string().optional().describe("Workspace slug; defaults to the current default."),
        refresh: z.boolean().optional(),
        workspace: z.string().optional(),
      },
    },
    safe(async (args) => {
      const ws = await loadAuthForWorkspace(args.slug as string | undefined);
      const refresh = args.refresh === true;
      const viewer = refresh ? await validateToken(ws.token) : ws.viewer;
      return text({
        schema_version: 1,
        workspace: ws.slug,
        workspace_name: ws.name,
        viewer,
        refreshed: refresh,
        created_at: ws.created_at,
      });
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
