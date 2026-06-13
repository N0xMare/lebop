export type ParityMapping =
  | { type: "cli"; tools: string[] }
  | { type: "mcp"; tools: string[] }
  | { type: "exception"; reason: string };

export interface CliSurfaceEntry {
  command: string;
  maps_to: ParityMapping;
  notes?: string;
  issue_fields?: readonly string[];
  issue_update_mode?: "one_field_per_call" | "multi_field_per_call";
}

export type CliLiveCoverageEntry =
  | {
      command: string;
      live_steps: readonly string[];
    }
  | {
      command: string;
      non_live_reason: string;
    };

export interface McpSurfaceEntry {
  tool: string;
  maps_to: ParityMapping;
  notes?: string;
  issue_fields?: readonly string[];
  issue_update_mode?: "one_field_per_call" | "multi_field_per_call";
  destructive_confirm?: "required" | "required_when_mutating" | "not_required";
  live_semantics?: "required" | "optional";
}

export const CLI_MCP_PARITY_MANIFEST_VERSION = 1;

export const CLI_SET_ISSUE_FIELDS = [
  "title",
  "description",
  "state",
  "priority",
  "estimate",
  "assignee",
  "labels",
  "parent",
  "project",
  "milestone",
  "cycle",
  "links",
] as const;

export const MCP_UPDATE_ISSUE_FIELDS = [
  "title",
  "description",
  "state",
  "priority",
  "estimate",
  "assignee",
  "labels",
  "labels_add",
  "labels_remove",
  "parent",
  "project",
  "milestone",
  "cycle",
] as const;

export const CLI_SURFACE_MANIFEST: CliSurfaceEntry[] = [
  { command: "auth login", maps_to: { type: "exception", reason: "CLI-only credential setup" } },
  {
    command: "auth logout",
    maps_to: { type: "exception", reason: "CLI-only credential teardown" },
  },
  { command: "auth list", maps_to: { type: "mcp", tools: ["list_workspaces"] } },
  {
    command: "auth default",
    maps_to: { type: "mcp", tools: ["list_workspaces", "set_default_workspace"] },
    notes:
      "No-arg read mode maps to list_workspaces.default; setter mode maps to set_default_workspace.",
  },
  {
    command: "auth token",
    maps_to: { type: "exception", reason: "secret-printing CLI escape hatch" },
  },
  { command: "auth whoami", maps_to: { type: "mcp", tools: ["whoami", "refresh_whoami"] } },
  {
    command: "auth set-default-team",
    maps_to: { type: "mcp", tools: ["set_workspace_default_team"] },
  },
  { command: "workspace explore", maps_to: { type: "mcp", tools: ["explore_linear_workspace"] } },
  { command: "workspace fetch", maps_to: { type: "mcp", tools: ["fetch_linear_workspace"] } },
  { command: "list", maps_to: { type: "mcp", tools: ["list_issues"] } },
  {
    command: "mine",
    maps_to: { type: "mcp", tools: ["list_issues"] },
    notes:
      "Recipe: list_issues({ assignee: 'me', active_only: true }) matches default mine; pass all_states:true to include completed/canceled assigned issues.",
  },
  { command: "show", maps_to: { type: "mcp", tools: ["get_issue"] } },
  { command: "new", maps_to: { type: "mcp", tools: ["create_issue"] } },
  {
    command: "set",
    maps_to: { type: "mcp", tools: ["update_issue", "update_relations"] },
    issue_fields: CLI_SET_ISSUE_FIELDS,
    issue_update_mode: "one_field_per_call",
    notes:
      "Field parity: CLI set supports direct issue fields one field per invocation, including description/project/milestone/cycle. CLI-only set links maps to relation add/delete semantics; content remains cache/publish-only.",
  },
  { command: "archive", maps_to: { type: "mcp", tools: ["archive_issue"] } },
  { command: "unarchive", maps_to: { type: "mcp", tools: ["unarchive_issue"] } },
  { command: "bulk update", maps_to: { type: "mcp", tools: ["bulk_update_issues"] } },
  { command: "comment add", maps_to: { type: "mcp", tools: ["add_comment"] } },
  { command: "comment list", maps_to: { type: "mcp", tools: ["list_comments"] } },
  { command: "comment update", maps_to: { type: "mcp", tools: ["update_comment"] } },
  { command: "comment delete", maps_to: { type: "mcp", tools: ["delete_comment"] } },
  { command: "relation add", maps_to: { type: "mcp", tools: ["add_relation"] } },
  { command: "relation list", maps_to: { type: "mcp", tools: ["list_relations"] } },
  { command: "relation delete", maps_to: { type: "mcp", tools: ["delete_relation"] } },
  { command: "link", maps_to: { type: "mcp", tools: ["link_url_to_issue"] } },
  { command: "attachment list", maps_to: { type: "mcp", tools: ["list_attachments"] } },
  { command: "attachment update", maps_to: { type: "mcp", tools: ["update_attachment"] } },
  { command: "attachment delete", maps_to: { type: "mcp", tools: ["delete_attachment"] } },
  { command: "pull", maps_to: { type: "mcp", tools: ["pull_issues", "pull_project"] } },
  { command: "push", maps_to: { type: "mcp", tools: ["push_changes"] } },
  { command: "status", maps_to: { type: "mcp", tools: ["cache_status"] } },
  { command: "cache status", maps_to: { type: "mcp", tools: ["cache_status"] } },
  { command: "cache gc", maps_to: { type: "mcp", tools: ["cache_gc"] } },
  { command: "diff", maps_to: { type: "mcp", tools: ["diff_issue", "diff_project"] } },
  { command: "publish review", maps_to: { type: "mcp", tools: ["review_linear_changes"] } },
  { command: "publish apply", maps_to: { type: "mcp", tools: ["publish_linear_changes"] } },
  { command: "plan validate", maps_to: { type: "mcp", tools: ["plan_validate"] } },
  { command: "plan apply", maps_to: { type: "mcp", tools: ["plan_apply"] } },
  { command: "plan diff", maps_to: { type: "mcp", tools: ["plan_diff"] } },
  { command: "plan lint", maps_to: { type: "mcp", tools: ["plan_lint"] } },
  { command: "plan pull", maps_to: { type: "mcp", tools: ["plan_pull"] } },
  { command: "lint", maps_to: { type: "mcp", tools: ["lint_files"] } },
  { command: "raw", maps_to: { type: "mcp", tools: ["raw_graphql"] } },
  {
    command: "mcp",
    maps_to: { type: "exception", reason: "CLI-only MCP stdio server entrypoint" },
  },
  {
    command: "schema",
    maps_to: { type: "exception", reason: "CLI-only local GraphQL schema export" },
  },
  { command: "completions", maps_to: { type: "exception", reason: "CLI shell integration" } },
  { command: "teams", maps_to: { type: "mcp", tools: ["list_teams"] } },
  { command: "team members", maps_to: { type: "mcp", tools: ["list_team_members"] } },
  { command: "team get", maps_to: { type: "mcp", tools: ["get_team"] } },
  { command: "team workflow-states", maps_to: { type: "mcp", tools: ["list_workflow_states"] } },
  { command: "lookup state", maps_to: { type: "mcp", tools: ["lookup_state_by_name"] } },
  { command: "lookup user", maps_to: { type: "mcp", tools: ["lookup_user_by_email"] } },
  { command: "projects", maps_to: { type: "mcp", tools: ["list_projects"] } },
  { command: "project list", maps_to: { type: "mcp", tools: ["list_projects"] } },
  { command: "project view", maps_to: { type: "mcp", tools: ["get_project"] } },
  { command: "project create", maps_to: { type: "mcp", tools: ["create_project"] } },
  { command: "project update", maps_to: { type: "mcp", tools: ["update_project"] } },
  { command: "project delete", maps_to: { type: "mcp", tools: ["delete_project"] } },
  { command: "project-update create", maps_to: { type: "mcp", tools: ["create_project_update"] } },
  { command: "project-update list", maps_to: { type: "mcp", tools: ["list_project_updates"] } },
  { command: "initiative list", maps_to: { type: "mcp", tools: ["list_initiatives"] } },
  { command: "initiative view", maps_to: { type: "mcp", tools: ["get_initiative"] } },
  { command: "initiative create", maps_to: { type: "mcp", tools: ["create_initiative"] } },
  { command: "initiative update", maps_to: { type: "mcp", tools: ["update_initiative"] } },
  { command: "initiative archive", maps_to: { type: "mcp", tools: ["archive_initiative"] } },
  { command: "initiative unarchive", maps_to: { type: "mcp", tools: ["unarchive_initiative"] } },
  { command: "initiative delete", maps_to: { type: "mcp", tools: ["delete_initiative"] } },
  {
    command: "initiative add-project",
    maps_to: { type: "mcp", tools: ["initiative_add_project"] },
  },
  {
    command: "initiative remove-project",
    maps_to: { type: "mcp", tools: ["initiative_remove_project"] },
  },
  {
    command: "initiative-update create",
    maps_to: { type: "mcp", tools: ["create_initiative_update"] },
  },
  {
    command: "initiative-update list",
    maps_to: { type: "mcp", tools: ["list_initiative_updates"] },
  },
  { command: "cycle list", maps_to: { type: "mcp", tools: ["list_cycles"] } },
  { command: "cycle view", maps_to: { type: "mcp", tools: ["get_cycle"] } },
  { command: "document list", maps_to: { type: "mcp", tools: ["list_documents"] } },
  { command: "document view", maps_to: { type: "mcp", tools: ["get_document"] } },
  { command: "document create", maps_to: { type: "mcp", tools: ["create_document"] } },
  { command: "document update", maps_to: { type: "mcp", tools: ["update_document"] } },
  { command: "document delete", maps_to: { type: "mcp", tools: ["delete_document"] } },
  { command: "agent-session list", maps_to: { type: "mcp", tools: ["list_agent_sessions"] } },
  { command: "agent-session view", maps_to: { type: "mcp", tools: ["get_agent_session"] } },
  { command: "label list", maps_to: { type: "mcp", tools: ["list_labels"] } },
  { command: "label create", maps_to: { type: "mcp", tools: ["create_label"] } },
  { command: "label delete", maps_to: { type: "mcp", tools: ["delete_label"] } },
  { command: "milestone list", maps_to: { type: "mcp", tools: ["list_milestones"] } },
  { command: "milestone view", maps_to: { type: "mcp", tools: ["get_milestone"] } },
  { command: "milestone create", maps_to: { type: "mcp", tools: ["create_milestone"] } },
  { command: "milestone update", maps_to: { type: "mcp", tools: ["update_milestone"] } },
  { command: "milestone delete", maps_to: { type: "mcp", tools: ["delete_milestone"] } },
];

export const CLI_LIVE_COVERAGE_MANIFEST: CliLiveCoverageEntry[] = [
  { command: "auth login", live_steps: ["cli:auth login --token-file"] },
  {
    command: "auth logout",
    non_live_reason:
      "Credential teardown is exercised as cleanup after coverage validation; requiring it as an in-band live step would invalidate the remaining authenticated surface.",
  },
  { command: "auth list", live_steps: ["cli:auth list --json"] },
  { command: "auth default", live_steps: ["cli:auth default"] },
  { command: "auth token", live_steps: ["cli:auth token masked"] },
  {
    command: "auth whoami",
    live_steps: ["cli:auth whoami --json", "cli:auth whoami --refresh --json"],
  },
  { command: "auth set-default-team", live_steps: ["cli:auth set-default-team --json"] },
  {
    command: "workspace explore",
    live_steps: [
      "cli:workspace explore root --json",
      "cli:workspace explore projects cursor page 1 --json",
      "cli:workspace explore projects cursor page 2 --json",
      "cli:workspace explore project search --json",
      "cli:workspace explore initiative search --json",
      "cli:workspace explore initiative --json",
      "cli:workspace explore issue --json",
      "cli:workspace explore issue documents --json",
      "cli:workspace explore cycle issues --json",
      "cli:workspace explore project --json",
      "cli:workspace explore project issues --json",
      "cli:workspace explore milestone issues --json",
    ],
  },
  {
    command: "workspace fetch",
    live_steps: [
      "cli:workspace fetch document --json",
      "cli:workspace fetch initiative --json",
      "cli:workspace fetch issue --json",
      "cli:workspace fetch issue documents --json",
      "cli:workspace fetch issue agent-sessions --json",
      "cli:workspace fetch cycle --json",
      "cli:workspace fetch agent-session --json",
      "cli:workspace fetch project --json",
      "cli:workspace fetch milestone --json",
    ],
  },
  { command: "list", live_steps: ["cli:list --json"] },
  { command: "mine", live_steps: ["cli:mine --json"] },
  { command: "show", live_steps: ["cli:show --json"] },
  { command: "new", live_steps: ["cli:new --description-file --json", "cli:new --stdin --json"] },
  {
    command: "set",
    live_steps: [
      "cli:set title --json",
      "cli:set state --json",
      "cli:set priority --json",
      "cli:set estimate --json",
      "cli:set assignee --json",
      "cli:set description --json",
      "cli:set project --json",
      "cli:set milestone --json",
      "cli:set cycle --json",
      "cli:set labels exact --json",
      "cli:set parent --json",
      "cli:set parent clear --json",
      "cli:set links add --json",
      "cli:set links remove --json",
    ],
  },
  {
    command: "archive",
    live_steps: [
      "cli:archive/unarchive issue --json",
      "cli:archive issue final --json",
      "cli:archive primary evidence issue --json",
    ],
  },
  {
    command: "unarchive",
    live_steps: ["cli:archive/unarchive issue --json", "cli:unarchive issue --json"],
  },
  { command: "bulk update", live_steps: ["cli:bulk update --json"] },
  {
    command: "comment add",
    live_steps: ["cli:comment add --json", "cli:comment add reply --json"],
  },
  { command: "comment list", live_steps: ["cli:comment list --json"] },
  { command: "comment update", live_steps: ["cli:comment update --json"] },
  {
    command: "comment delete",
    live_steps: ["cli:comment delete reply --json", "cli:comment delete --json"],
  },
  { command: "relation add", live_steps: ["cli:relation add/list/delete --json"] },
  {
    command: "relation list",
    live_steps: ["cli:relation add/list/delete --json", "cli:relation list --json"],
  },
  {
    command: "relation delete",
    live_steps: ["cli:relation add/list/delete --json", "cli:relation delete --json"],
  },
  { command: "link", live_steps: ["cli:link --json"] },
  { command: "attachment list", live_steps: ["cli:attachment list --json"] },
  {
    command: "attachment update",
    live_steps: ["cli:attachment update --json", "cli:attachment update url unsupported --json"],
  },
  { command: "attachment delete", live_steps: ["cli:attachment delete --json"] },
  {
    command: "pull",
    live_steps: ["cli:pull issue --json", "cli:pull project --json", "cli:pull --to export --json"],
  },
  { command: "push", live_steps: ["cli:push issue --json"] },
  { command: "status", live_steps: ["cli:status --json"] },
  { command: "cache status", live_steps: ["cli:cache status --json"] },
  { command: "cache gc", live_steps: ["cli:cache gc dry-run --json"] },
  { command: "diff", live_steps: ["cli:diff issue --json"] },
  {
    command: "publish review",
    live_steps: [
      "cli:publish review cache issue --json",
      "cli:publish review cache project --json",
      "cli:publish review --plan --json",
    ],
  },
  {
    command: "publish apply",
    live_steps: [
      "cli:publish apply cache issue --json",
      "cli:publish apply cache project --json",
      "cli:publish apply --json",
    ],
  },
  { command: "plan validate", live_steps: ["cli:plan validate --json"] },
  { command: "plan apply", live_steps: ["cli:plan apply dry-run --json", "cli:plan apply --json"] },
  { command: "plan diff", live_steps: ["cli:plan diff --json"] },
  { command: "plan lint", live_steps: ["cli:plan lint --json"] },
  { command: "plan pull", live_steps: ["cli:plan pull --json"] },
  { command: "lint", live_steps: ["cli:lint --json"] },
  { command: "raw", live_steps: ["cli:raw", "cli:raw query-file"] },
  {
    command: "mcp",
    non_live_reason:
      "The CLI entrypoint starts the MCP transport; live coverage is recorded through the MCP tool matrix and compiled pre-auth MCP handshake instead of a CLI semantic step.",
  },
  { command: "schema", live_steps: ["cli:schema --json"] },
  { command: "completions", live_steps: ["cli:completions bash"] },
  { command: "teams", live_steps: ["cli:teams --json"] },
  { command: "team members", live_steps: ["cli:team members --json"] },
  { command: "team get", live_steps: ["cli:team get --json"] },
  { command: "team workflow-states", live_steps: ["cli:team workflow-states --json"] },
  { command: "lookup state", live_steps: ["cli:lookup state"] },
  { command: "lookup user", live_steps: ["cli:lookup user"] },
  { command: "projects", live_steps: ["cli:projects alias --json"] },
  { command: "project list", live_steps: ["cli:project list --json"] },
  { command: "project view", live_steps: ["cli:project view --json"] },
  { command: "project create", live_steps: ["cli:project create --json"] },
  { command: "project update", live_steps: ["cli:project update --json"] },
  { command: "project delete", live_steps: ["cli:project delete --json"] },
  { command: "project-update create", live_steps: ["cli:project-update create --json"] },
  { command: "project-update list", live_steps: ["cli:project-update list --json"] },
  { command: "initiative list", live_steps: ["cli:initiative list --json"] },
  { command: "initiative view", live_steps: ["cli:initiative view --json"] },
  { command: "initiative create", live_steps: ["cli:initiative create --json"] },
  { command: "initiative update", live_steps: ["cli:initiative update --json"] },
  { command: "initiative archive", live_steps: ["cli:initiative archive --json"] },
  { command: "initiative unarchive", live_steps: ["cli:initiative unarchive --json"] },
  { command: "initiative delete", live_steps: ["cli:initiative delete --json"] },
  { command: "initiative add-project", live_steps: ["cli:initiative add-project --json"] },
  {
    command: "initiative remove-project",
    live_steps: ["cli:initiative remove-project --json"],
  },
  {
    command: "initiative-update create",
    live_steps: ["cli:initiative-update create --json"],
  },
  { command: "initiative-update list", live_steps: ["cli:initiative-update list --json"] },
  { command: "cycle list", live_steps: ["cli:cycle list --json"] },
  { command: "cycle view", live_steps: ["cli:cycle view --json"] },
  { command: "document list", live_steps: ["cli:document list --json"] },
  { command: "document view", live_steps: ["cli:document view --json"] },
  { command: "document create", live_steps: ["cli:document create --content-file --json"] },
  { command: "document update", live_steps: ["cli:document update --stdin --json"] },
  { command: "document delete", live_steps: ["cli:document delete --json"] },
  { command: "agent-session list", live_steps: ["cli:agent-session list --json"] },
  { command: "agent-session view", live_steps: ["cli:agent-session view --json"] },
  {
    command: "label list",
    live_steps: ["cli:label list --json", "cli:label list --workspace-only --json"],
  },
  { command: "label create", live_steps: ["cli:label create --json"] },
  { command: "label delete", live_steps: ["cli:label delete --json"] },
  { command: "milestone list", live_steps: ["cli:milestone list --json"] },
  { command: "milestone view", live_steps: ["cli:milestone view --json"] },
  { command: "milestone create", live_steps: ["cli:milestone create --json"] },
  { command: "milestone update", live_steps: ["cli:milestone update --json"] },
  { command: "milestone delete", live_steps: ["cli:milestone delete --json"] },
];

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export const REQUIRED_CLI_LIVE_STEPS = uniqueStrings(
  CLI_LIVE_COVERAGE_MANIFEST.flatMap((entry) =>
    "live_steps" in entry ? [...entry.live_steps] : [],
  ),
);

export const MCP_SURFACE_MANIFEST: McpSurfaceEntry[] = [
  {
    tool: "explore_linear_workspace",
    maps_to: { type: "cli", tools: ["workspace explore"] },
    live_semantics: "required",
  },
  {
    tool: "fetch_linear_workspace",
    maps_to: { type: "cli", tools: ["workspace fetch"] },
    live_semantics: "required",
  },
  { tool: "list_issues", maps_to: { type: "cli", tools: ["list", "mine"] } },
  {
    tool: "add_relation",
    maps_to: { type: "cli", tools: ["relation add"] },
    destructive_confirm: "required_when_mutating",
  },
  {
    tool: "update_relations",
    maps_to: { type: "cli", tools: ["set"] },
    notes:
      "Batch relation delta parity for `lebop set links`: applies multiple add/remove relation deltas for one source issue.",
    destructive_confirm: "required_when_mutating",
    live_semantics: "required",
  },
  { tool: "list_relations", maps_to: { type: "cli", tools: ["relation list"] } },
  {
    tool: "delete_relation",
    maps_to: { type: "cli", tools: ["relation delete"] },
    destructive_confirm: "required",
  },
  { tool: "list_labels", maps_to: { type: "cli", tools: ["label list"] } },
  { tool: "create_label", maps_to: { type: "cli", tools: ["label create"] } },
  {
    tool: "delete_label",
    maps_to: { type: "cli", tools: ["label delete"] },
    destructive_confirm: "required",
  },
  {
    tool: "lookup_label_by_name",
    maps_to: { type: "exception", reason: "MCP-only delete preflight helper" },
  },
  { tool: "list_milestones", maps_to: { type: "cli", tools: ["milestone list"] } },
  { tool: "get_milestone", maps_to: { type: "cli", tools: ["milestone view"] } },
  { tool: "create_milestone", maps_to: { type: "cli", tools: ["milestone create"] } },
  { tool: "update_milestone", maps_to: { type: "cli", tools: ["milestone update"] } },
  {
    tool: "delete_milestone",
    maps_to: { type: "cli", tools: ["milestone delete"] },
    destructive_confirm: "required",
  },
  { tool: "list_projects", maps_to: { type: "cli", tools: ["projects", "project list"] } },
  { tool: "get_project", maps_to: { type: "cli", tools: ["project view"] } },
  { tool: "create_project", maps_to: { type: "cli", tools: ["project create"] } },
  { tool: "update_project", maps_to: { type: "cli", tools: ["project update"] } },
  {
    tool: "delete_project",
    maps_to: { type: "cli", tools: ["project delete"] },
    destructive_confirm: "required",
  },
  { tool: "list_project_updates", maps_to: { type: "cli", tools: ["project-update list"] } },
  { tool: "create_project_update", maps_to: { type: "cli", tools: ["project-update create"] } },
  { tool: "list_initiatives", maps_to: { type: "cli", tools: ["initiative list"] } },
  { tool: "get_initiative", maps_to: { type: "cli", tools: ["initiative view"] } },
  { tool: "create_initiative", maps_to: { type: "cli", tools: ["initiative create"] } },
  { tool: "update_initiative", maps_to: { type: "cli", tools: ["initiative update"] } },
  {
    tool: "archive_initiative",
    maps_to: { type: "cli", tools: ["initiative archive"] },
    destructive_confirm: "required",
  },
  { tool: "unarchive_initiative", maps_to: { type: "cli", tools: ["initiative unarchive"] } },
  {
    tool: "delete_initiative",
    maps_to: { type: "cli", tools: ["initiative delete"] },
    destructive_confirm: "required",
  },
  { tool: "initiative_add_project", maps_to: { type: "cli", tools: ["initiative add-project"] } },
  {
    tool: "initiative_remove_project",
    maps_to: { type: "cli", tools: ["initiative remove-project"] },
    destructive_confirm: "required",
  },
  { tool: "list_initiative_updates", maps_to: { type: "cli", tools: ["initiative-update list"] } },
  {
    tool: "create_initiative_update",
    maps_to: { type: "cli", tools: ["initiative-update create"] },
  },
  { tool: "list_cycles", maps_to: { type: "cli", tools: ["cycle list"] } },
  { tool: "get_cycle", maps_to: { type: "cli", tools: ["cycle view"] } },
  { tool: "list_documents", maps_to: { type: "cli", tools: ["document list"] } },
  { tool: "get_document", maps_to: { type: "cli", tools: ["document view"] } },
  { tool: "create_document", maps_to: { type: "cli", tools: ["document create"] } },
  { tool: "update_document", maps_to: { type: "cli", tools: ["document update"] } },
  {
    tool: "delete_document",
    maps_to: { type: "cli", tools: ["document delete"] },
    destructive_confirm: "required",
  },
  { tool: "list_agent_sessions", maps_to: { type: "cli", tools: ["agent-session list"] } },
  { tool: "get_agent_session", maps_to: { type: "cli", tools: ["agent-session view"] } },
  { tool: "list_team_members", maps_to: { type: "cli", tools: ["team members"] } },
  { tool: "lint_files", maps_to: { type: "cli", tools: ["lint"] } },
  {
    tool: "lint_text",
    maps_to: {
      type: "exception",
      reason: "MCP-only content-string linter; use lint_files for CLI lint parity.",
    },
  },
  { tool: "get_issue", maps_to: { type: "cli", tools: ["show"] } },
  { tool: "create_issue", maps_to: { type: "cli", tools: ["new"] }, live_semantics: "required" },
  {
    tool: "update_issue",
    maps_to: { type: "cli", tools: ["set"] },
    issue_fields: MCP_UPDATE_ISSUE_FIELDS,
    issue_update_mode: "multi_field_per_call",
    notes:
      "Field parity: update_issue supports the direct issue fields that CLI set supports except set links, and can update multiple fields in one call. Content remains cache/publish-only.",
    live_semantics: "required",
  },
  {
    tool: "archive_issue",
    maps_to: { type: "cli", tools: ["archive"] },
    destructive_confirm: "required",
  },
  { tool: "unarchive_issue", maps_to: { type: "cli", tools: ["unarchive"] } },
  { tool: "list_comments", maps_to: { type: "cli", tools: ["comment list"] } },
  { tool: "add_comment", maps_to: { type: "cli", tools: ["comment add"] } },
  { tool: "update_comment", maps_to: { type: "cli", tools: ["comment update"] } },
  {
    tool: "delete_comment",
    maps_to: { type: "cli", tools: ["comment delete"] },
    destructive_confirm: "required",
  },
  { tool: "cache_status", maps_to: { type: "cli", tools: ["status", "cache status"] } },
  { tool: "diff_issue", maps_to: { type: "cli", tools: ["diff"] } },
  { tool: "diff_project", maps_to: { type: "cli", tools: ["diff"] } },
  {
    tool: "pull_issues",
    maps_to: { type: "cli", tools: ["pull"] },
    live_semantics: "required",
    destructive_confirm: "required_when_mutating",
  },
  {
    tool: "pull_project",
    maps_to: { type: "cli", tools: ["pull"] },
    live_semantics: "required",
    destructive_confirm: "required_when_mutating",
  },
  {
    tool: "push_changes",
    maps_to: { type: "cli", tools: ["push"] },
    destructive_confirm: "required_when_mutating",
  },
  {
    tool: "review_linear_changes",
    maps_to: { type: "cli", tools: ["publish review"] },
    live_semantics: "required",
  },
  {
    tool: "publish_linear_changes",
    maps_to: { type: "cli", tools: ["publish apply"] },
    live_semantics: "required",
  },
  { tool: "plan_validate", maps_to: { type: "cli", tools: ["plan validate"] } },
  { tool: "plan_lint", maps_to: { type: "cli", tools: ["plan lint"] } },
  {
    tool: "plan_apply",
    maps_to: { type: "cli", tools: ["plan apply"] },
    destructive_confirm: "required_when_mutating",
  },
  { tool: "plan_diff", maps_to: { type: "cli", tools: ["plan diff"] } },
  {
    tool: "plan_pull",
    maps_to: { type: "cli", tools: ["plan pull"] },
    destructive_confirm: "required_when_mutating",
  },
  { tool: "link_url_to_issue", maps_to: { type: "cli", tools: ["link"] } },
  {
    tool: "raw_graphql",
    maps_to: { type: "cli", tools: ["raw"] },
    destructive_confirm: "required_when_mutating",
  },
  { tool: "list_workspaces", maps_to: { type: "cli", tools: ["auth list", "auth default"] } },
  { tool: "list_teams", maps_to: { type: "cli", tools: ["teams"] } },
  {
    tool: "set_default_workspace",
    maps_to: { type: "cli", tools: ["auth default"] },
    notes: "Setter mode only; auth default read mode maps to list_workspaces.default.",
  },
  { tool: "whoami", maps_to: { type: "cli", tools: ["auth whoami"] } },
  {
    tool: "refresh_whoami",
    maps_to: { type: "cli", tools: ["auth whoami"] },
    notes: "Refresh mode for `lebop auth whoami --refresh`; writes refreshed auth metadata.",
  },
  {
    tool: "cache_gc",
    maps_to: { type: "cli", tools: ["cache gc"] },
    destructive_confirm: "required_when_mutating",
  },
  { tool: "list_attachments", maps_to: { type: "cli", tools: ["attachment list"] } },
  { tool: "update_attachment", maps_to: { type: "cli", tools: ["attachment update"] } },
  {
    tool: "delete_attachment",
    maps_to: { type: "cli", tools: ["attachment delete"] },
    destructive_confirm: "required",
  },
  { tool: "get_team", maps_to: { type: "cli", tools: ["team get"] } },
  { tool: "lookup_state_by_name", maps_to: { type: "cli", tools: ["lookup state"] } },
  { tool: "lookup_user_by_email", maps_to: { type: "cli", tools: ["lookup user"] } },
  {
    tool: "set_workspace_default_team",
    maps_to: { type: "cli", tools: ["auth set-default-team"] },
  },
  {
    tool: "bulk_update_issues",
    maps_to: { type: "cli", tools: ["bulk update"] },
    live_semantics: "required",
    destructive_confirm: "required_when_mutating",
  },
  { tool: "list_workflow_states", maps_to: { type: "cli", tools: ["team workflow-states"] } },
];

export const REQUIRED_MCP_CONFIRM_TOOLS = MCP_SURFACE_MANIFEST.filter(
  (entry) => entry.destructive_confirm === "required",
).map((entry) => entry.tool);

export const CONDITIONAL_MCP_CONFIRM_TOOLS = MCP_SURFACE_MANIFEST.filter(
  (entry) => entry.destructive_confirm === "required_when_mutating",
).map((entry) => entry.tool);
