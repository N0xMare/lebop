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
import { getCycle, listCycles } from "../lib/cycles.ts";
import { LebopError } from "../lib/errors.ts";
import {
  type InitiativeHealth,
  archiveInitiative,
  createInitiative,
  createInitiativeUpdate,
  deleteInitiative,
  getInitiative,
  initiativeAddProject,
  initiativeRemoveProject,
  listInitiativeUpdates,
  listInitiatives,
  resolveInitiativeId,
  unarchiveInitiative,
  updateInitiative,
} from "../lib/initiatives.ts";
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
import {
  type ProjectHealth,
  createProject,
  createProjectUpdate,
  deleteProject,
  getProject,
  listProjectUpdates,
  listProjects,
  updateProject,
} from "../lib/projects.ts";
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
    async (args) => {
      withWorkspace(args.workspace);
      const labels = await listLabels({
        team: args.workspace_only || args.all ? undefined : args.team,
        workspaceOnly: args.workspace_only,
        all: args.all,
      });
      return text({ schema_version: 1, count: labels.length, labels });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const label = await createLabel({
        name: args.name,
        teamId: args.team_id,
        color: args.color,
        description: args.description,
      });
      return text({ schema_version: 1, label });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const success = await deleteLabel(args.id);
      return text({ schema_version: 1, id: args.id, success });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const label = await resolveLabelByName(args.name, args.team);
      return text({ schema_version: 1, label });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      let projectId: string | undefined;
      if (args.project) {
        const resolved = await resolveProjectId(args.project);
        if (!resolved) throw new Error(`project not found: ${args.project}`);
        projectId = resolved;
      }
      const milestones = await listMilestones({ projectId });
      return text({ schema_version: 1, count: milestones.length, milestones });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const milestone = await getMilestone(args.id);
      return text({ schema_version: 1, milestone });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
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
    },
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
    async (args) => {
      withWorkspace(args.workspace);
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
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const success = await deleteMilestone(args.id);
      return text({ schema_version: 1, id: args.id, success });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const records = await listProjects({ team: args.team, state: args.state, max });
      return text({ schema_version: 1, count: records.length, projects: records });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const project = await getProject(args.id);
      return text({ schema_version: 1, project });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
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
    },
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
    async (args) => {
      withWorkspace(args.workspace);
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
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const success = await deleteProject(args.id);
      return text({ schema_version: 1, id: args.id, success });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const projectId = await resolveProjectId(args.project);
      if (!projectId) throw new Error(`project not found: ${args.project}`);
      const updates = await listProjectUpdates(projectId);
      return text({ schema_version: 1, project_id: projectId, count: updates.length, updates });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const projectId = await resolveProjectId(args.project);
      if (!projectId) throw new Error(`project not found: ${args.project}`);
      const update = await createProjectUpdate({
        projectId,
        body: args.body,
        health: args.health as ProjectHealth | undefined,
      });
      return text({ schema_version: 1, project_update: update });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const initiatives = await listInitiatives({
        status: args.status,
        ownerId: args.owner_id,
        includeArchived: args.include_archived,
        max,
      });
      return text({ schema_version: 1, count: initiatives.length, initiatives });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const id = await resolveInitiativeId(args.id_or_name);
      if (!id) return text({ schema_version: 1, initiative: null });
      const initiative = await getInitiative(id);
      return text({ schema_version: 1, initiative });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
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
    },
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
    async (args) => {
      withWorkspace(args.workspace);
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
    },
  );

  server.registerTool(
    "archive_initiative",
    {
      title: "Archive an initiative (reversible)",
      description: "NOT retry-wrapped.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    async (args) => {
      withWorkspace(args.workspace);
      const success = await archiveInitiative(args.id);
      return text({ schema_version: 1, id: args.id, success });
    },
  );

  server.registerTool(
    "unarchive_initiative",
    {
      title: "Unarchive an initiative",
      description: "NOT retry-wrapped.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    async (args) => {
      withWorkspace(args.workspace);
      const success = await unarchiveInitiative(args.id);
      return text({ schema_version: 1, id: args.id, success });
    },
  );

  server.registerTool(
    "delete_initiative",
    {
      title: "Delete an initiative permanently",
      description: "NOT retry-wrapped.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    async (args) => {
      withWorkspace(args.workspace);
      const success = await deleteInitiative(args.id);
      return text({ schema_version: 1, id: args.id, success });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
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
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId) throw new Error(`initiative not found: ${args.initiative}`);
      const projectId = await resolveProjectId(args.project);
      if (!projectId) throw new Error(`project not found: ${args.project}`);
      const success = await initiativeRemoveProject({ initiativeId, projectId });
      return text({ schema_version: 1, success });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId) throw new Error(`initiative not found: ${args.initiative}`);
      const updates = await listInitiativeUpdates(initiativeId);
      return text({
        schema_version: 1,
        initiative_id: initiativeId,
        count: updates.length,
        updates,
      });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId) throw new Error(`initiative not found: ${args.initiative}`);
      const update = await createInitiativeUpdate({
        initiativeId,
        body: args.body,
        health: args.health as InitiativeHealth | undefined,
      });
      return text({ schema_version: 1, initiative_update: update });
    },
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
    async (args) => {
      withWorkspace(args.workspace);
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const cycles = await listCycles({ team: args.team, max });
      return text({ schema_version: 1, count: cycles.length, cycles });
    },
  );

  server.registerTool(
    "get_cycle",
    {
      title: "Get one cycle by UUID",
      description: "Returns null if not found.",
      inputSchema: { id: z.string(), workspace: z.string().optional() },
    },
    async (args) => {
      withWorkspace(args.workspace);
      const cycle = await getCycle(args.id);
      return text({ schema_version: 1, cycle });
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
