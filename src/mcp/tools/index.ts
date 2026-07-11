import { registerMcpToolSpecs } from "../adapter.ts";
import type { McpServerLike, McpToolSpec } from "../types.ts";
import { type AgentSessionToolDeps, buildAgentSessionsToolSpecs } from "./agent-sessions.ts";
import { type AttachmentToolDeps, buildAttachmentsToolSpecs } from "./attachments.ts";
import { type AuthToolDeps, buildAuthToolSpecs } from "./auth.ts";
import { buildCacheToolSpecs, type CacheToolDeps } from "./cache.ts";
import { buildCommentToolSpecs, type CommentToolDeps } from "./comments.ts";
import { buildCyclesToolSpecs, type CycleToolDeps } from "./cycles.ts";
import { buildDocumentToolSpecs, type DocumentToolDeps } from "./documents.ts";
import {
  buildInitiativeUpdateToolSpecs,
  type InitiativeUpdateToolDeps,
} from "./initiative-updates.ts";
import { buildInitiativeToolSpecs, type InitiativeToolDeps } from "./initiatives.ts";
import {
  buildIssueBulkToolSpecs,
  buildIssueLifecycleToolSpecs,
  buildIssueListToolSpecs,
  type IssueToolDeps,
} from "./issues.ts";
import { buildLabelToolSpecs, type LabelToolDeps } from "./labels.ts";
import { buildLinkToolSpecs, type LinkToolDeps } from "./link.ts";
import { buildLintToolSpecs, type LintToolDeps } from "./lint.ts";
import { buildLookupToolSpecs, type LookupToolDeps } from "./lookups.ts";
import { buildMilestoneToolSpecs, type MilestoneToolDeps } from "./milestones.ts";
import { buildPlanToolSpecs, type PlanToolDeps } from "./plan.ts";
import { buildProjectUpdateToolSpecs, type ProjectUpdateToolDeps } from "./project-updates.ts";
import { buildProjectToolSpecs, type ProjectToolDeps } from "./projects.ts";
import { buildPublishToolSpecs, type PublishToolDeps } from "./publish.ts";
import { buildPullToolSpecs, type PullToolDeps } from "./pull.ts";
import { buildRawToolSpecs, type RawToolDeps } from "./raw.ts";
import { buildRelationToolSpecs, type RelationToolDeps } from "./relations.ts";
import { buildTeamToolSpecs, type TeamToolDeps } from "./teams.ts";
import { buildWorkspaceToolSpecs, type WorkspaceToolDeps } from "./workspace.ts";

/**
 * Unified deps bag for all domain MCP tool builders. Callers (server boot)
 * construct each domain slice; builders never import server-local helpers.
 */
export interface RegisterAllMcpToolsDeps {
  workspace: WorkspaceToolDeps;
  issues: IssueToolDeps;
  projects: ProjectToolDeps;
  pull: PullToolDeps;
  publish: PublishToolDeps;
  relations: RelationToolDeps;
  labels: LabelToolDeps;
  milestones: MilestoneToolDeps;
  projectUpdates: ProjectUpdateToolDeps;
  initiatives: InitiativeToolDeps;
  initiativeUpdates: InitiativeUpdateToolDeps;
  cycles: CycleToolDeps;
  documents: DocumentToolDeps;
  agentSessions: AgentSessionToolDeps;
  teams: TeamToolDeps;
  lint: LintToolDeps;
  comments: CommentToolDeps;
  cache: CacheToolDeps;
  plan: PlanToolDeps;
  link: LinkToolDeps;
  raw: RawToolDeps;
  auth: AuthToolDeps;
  attachments: AttachmentToolDeps;
  lookups: LookupToolDeps;
}

/**
 * Stable pre-modularization registration order (85 tools).
 * Some domain builders emit tools that historically sat in different slots;
 * we re-order by name here so runtime inventory order is frozen.
 */
const MCP_REGISTRATION_ORDER = [
  // workspace
  "explore_linear_workspace",
  "fetch_linear_workspace",
  // issue list
  "list_issues",
  // after issue list: relations → labels → milestones
  "add_relation",
  "update_relations",
  "list_relations",
  "delete_relation",
  "list_labels",
  "create_label",
  "delete_label",
  "lookup_label_by_name",
  "list_milestones",
  "get_milestone",
  "create_milestone",
  "update_milestone",
  "delete_milestone",
  // projects
  "list_projects",
  "get_project",
  "create_project",
  "update_project",
  "delete_project",
  // after projects
  "list_project_updates",
  "create_project_update",
  "list_initiatives",
  "get_initiative",
  "create_initiative",
  "update_initiative",
  "archive_initiative",
  "unarchive_initiative",
  "delete_initiative",
  "initiative_add_project",
  "initiative_remove_project",
  "list_initiative_updates",
  "create_initiative_update",
  "list_cycles",
  "get_cycle",
  "list_documents",
  "get_document",
  "create_document",
  "update_document",
  "delete_document",
  "list_agent_sessions",
  "get_agent_session",
  "list_team_members",
  "lint_text",
  // issue lifecycle
  "get_issue",
  "create_issue",
  "update_issue",
  "archive_issue",
  "unarchive_issue",
  // after lifecycle
  "list_comments",
  "add_comment",
  "update_comment",
  "delete_comment",
  "cache_status",
  "diff_issue",
  "diff_project",
  // pull
  "pull_issues",
  "pull_project",
  // after pull
  "push_changes",
  // publish
  "review_linear_changes",
  "publish_linear_changes",
  // after publish (interleaved auth/teams/cache/attachments/lookups)
  "plan_validate",
  "plan_lint",
  "plan_apply",
  "plan_diff",
  "plan_pull",
  "link_url_to_issue",
  "raw_graphql",
  "list_workspaces",
  "list_teams",
  "set_default_workspace",
  "whoami",
  "refresh_whoami",
  "cache_gc",
  "list_attachments",
  "update_attachment",
  "delete_attachment",
  "get_team",
  "lookup_state_by_name",
  "lookup_user_by_email",
  "set_workspace_default_team",
  // issue bulk
  "bulk_update_issues",
  // after bulk
  "list_workflow_states",
  // last (was post-registerAllMcpTools)
  "lint_files",
] as const;

function orderSpecs(specs: readonly McpToolSpec[], order: readonly string[]): McpToolSpec[] {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const orderSet = new Set(order);
  const ordered: McpToolSpec[] = [];
  const missing: string[] = [];
  for (const name of order) {
    const spec = byName.get(name);
    if (!spec) {
      missing.push(name);
      continue;
    }
    ordered.push(spec);
  }
  if (missing.length > 0) {
    throw new Error(`MCP tool specs missing for registration order: ${missing.join(", ")}`);
  }
  if (byName.size !== order.length) {
    const extras = [...byName.keys()].filter((name) => !orderSet.has(name));
    throw new Error(
      `MCP tool specs not in registration order (got ${byName.size}, expected ${order.length}): ${extras.join(", ")}`,
    );
  }
  return ordered;
}

/**
 * Register every MCP tool in frozen inventory order. Domain modules own tool
 * bodies; this file only wires builders + order.
 */
export function registerAllMcpTools(server: McpServerLike, deps: RegisterAllMcpToolsDeps): void {
  const specs: McpToolSpec[] = [
    ...buildWorkspaceToolSpecs(deps.workspace),
    ...buildIssueListToolSpecs(deps.issues),
    ...buildRelationToolSpecs(deps.relations),
    ...buildLabelToolSpecs(deps.labels),
    ...buildMilestoneToolSpecs(deps.milestones),
    ...buildProjectToolSpecs(deps.projects),
    ...buildProjectUpdateToolSpecs(deps.projectUpdates),
    ...buildInitiativeToolSpecs(deps.initiatives),
    ...buildInitiativeUpdateToolSpecs(deps.initiativeUpdates),
    ...buildCyclesToolSpecs(deps.cycles),
    ...buildDocumentToolSpecs(deps.documents),
    ...buildAgentSessionsToolSpecs(deps.agentSessions),
    ...buildTeamToolSpecs(deps.teams),
    ...buildLintToolSpecs(deps.lint),
    ...buildIssueLifecycleToolSpecs(deps.issues),
    ...buildCommentToolSpecs(deps.comments),
    ...buildCacheToolSpecs(deps.cache),
    ...buildPullToolSpecs(deps.pull),
    ...buildPublishToolSpecs(deps.publish),
    ...buildPlanToolSpecs(deps.plan),
    ...buildLinkToolSpecs(deps.link),
    ...buildRawToolSpecs(deps.raw),
    ...buildAuthToolSpecs(deps.auth),
    ...buildAttachmentsToolSpecs(deps.attachments),
    ...buildLookupToolSpecs(deps.lookups),
    ...buildIssueBulkToolSpecs(deps.issues),
  ];

  registerMcpToolSpecs(server, orderSpecs(specs, MCP_REGISTRATION_ORDER));
}
