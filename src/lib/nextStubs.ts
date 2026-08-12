/**
 * Dense agent-only next[] stubs (CLI verbs / MCP tool names).
 * Prefer short tokens over English sentences so control-plane envelopes stay cheap.
 */

/** CLI paginated list: cursor page or show/fields follow-ons. */
export function listNext(
  truncated: boolean,
  cursor: string | null | undefined,
  opts?: { show?: string; fieldsCmd?: string; extra?: string[] },
): string[] {
  if (truncated && cursor) return [`--cursor ${cursor}`];
  const show = opts?.show ?? "show <id>";
  const fields = opts?.fieldsCmd;
  return [show, ...(fields ? [fields] : []), ...(opts?.extra ?? [])];
}

/** CLI get/show shell follow-ons. */
export function showNext(opts?: {
  includeComments?: boolean;
  truncated?: boolean;
  identifier?: string;
}): string[] {
  if (opts?.truncated) {
    const id = opts.identifier ?? "<id>";
    return [`show ${id} --content-file ./content.md`, `show ${id} --full-content`, "set …"];
  }
  if (opts?.includeComments) {
    return ["set …", "comment list <id>", "history <id>"];
  }
  return ["show <id> --comments", "set …", "comment list <id>"];
}

/** MCP get_issue follow-ons when description was truncated. */
export function mcpGetIssueTruncatedNext(identifier: string): string[] {
  return [
    `get_issue identifier=${identifier} content_file=./content.md`,
    `get_issue identifier=${identifier} full_content=true`,
    "update_issue",
  ];
}

/** MCP push_changes follow-ons (full profile; cache loop). */
export function mcpPushNext(): string[] {
  return ["cache_status", "pull_issues", "review_linear_changes"];
}

/** MCP diff_issue / diff_project follow-ons (full profile). */
export function mcpDiffNext(): string[] {
  return ["push_changes", "pull_issues", "review_linear_changes"];
}

/** MCP publish apply success follow-ons (core-safe). */
export function mcpPublishApplyNext(): string[] {
  return ["list_issues", "get_issue", "review_linear_changes"];
}

/** CLI `set` point-edit success follow-ons (≤3 stubs). */
export function setNext(identifier: string, _field?: string): string[] {
  return [`show ${identifier}`, "set …", `comment list ${identifier}`];
}

/** CLI `pull` success follow-ons (≤3 stubs). */
export function pullNext(): string[] {
  return ["status", "diff", "push --dry-run"];
}

/** CLI `push` success follow-ons (≤3 stubs). */
export function pushNext(): string[] {
  return ["status", "pull --refresh --yes", "publish review --cache"];
}

/** CLI `archive` / `unarchive` success follow-ons (≤3 stubs). */
export function archiveNext(action: "archive" | "unarchive" = "archive"): string[] {
  if (action === "unarchive") return ["list", "show <id>", "archive"];
  return ["list", "show <id>", "unarchive"];
}

/** CLI `relation add|delete|list` machine follow-ons (≤3 stubs). */
export function relationNext(action: "add" | "delete" | "list"): string[] {
  if (action === "list") return ["relation add …", "show <id>", "set links …"];
  if (action === "delete") return ["relation list <id>", "show <id>", "relation add …"];
  return ["relation list <id>", "show <id>", "relation delete …"];
}

/** MCP paginated list: tool cursor=… or follow-on tool names. */
export function mcpListNext(
  tool: string,
  hasMore: boolean,
  cursor: string | null | undefined,
  followOns: string[] = [],
): string[] {
  if (hasMore && cursor) return [`${tool} cursor=${cursor}`];
  return followOns;
}

/** MCP get_* follow-ons (tool names only). */
export function mcpGetNext(...tools: string[]): string[] {
  return tools;
}

/** MCP `pull_issues` / `pull_project` success follow-ons (≤3 stubs). */
export function mcpPullNext(): string[] {
  return ["cache_status", "update_issue", "review_linear_changes"];
}

/** MCP `cache_status` follow-ons (≤3 stubs; core-profile-safe tool names only). */
export function mcpCacheStatusNext(): string[] {
  return ["pull_issues", "update_issue", "review_linear_changes"];
}

/** CLI plan validate success. */
export function planValidateNext(): string[] {
  return ["plan apply", "plan diff", "publish review --plan"];
}

/** CLI plan apply success. */
export function planApplyNext(): string[] {
  return ["publish review --plan", "plan diff", "status"];
}

/** CLI plan diff / lint / pull. */
export function planDiffNext(): string[] {
  return ["plan apply", "publish review --plan", "plan validate"];
}

export function planLintNext(): string[] {
  return ["plan validate", "plan apply", "plan diff"];
}

export function planPullNext(): string[] {
  return ["plan diff", "plan apply", "publish review --plan"];
}

/** CLI cache diff (issue/project). */
export function diffNext(): string[] {
  return ["push --dry-run", "push", "pull --refresh --yes"];
}

/** CLI link URL attach. */
export function linkNext(identifier?: string): string[] {
  const id = identifier ?? "<id>";
  return [`show ${id}`, `attachment list ${id}`, "relation list <id>"];
}

/** CLI attachment list/update/delete. */
export function attachmentNext(action: "list" | "update" | "delete" = "list"): string[] {
  if (action === "delete") return ["attachment list <issue>", "show <id>", "link <issue> <url>"];
  if (action === "update") return ["attachment list <issue>", "show <id>", "attachment delete <id>"];
  return ["show <id>", "link <issue> <url>", "attachment update <id>"];
}

/** CLI bulk update. */
export function bulkNext(): string[] {
  return ["list", "show <id>", "bulk update … --dry-run"];
}

/** MCP get_document / get_project / get_initiative when body truncated. */
export function mcpEntityTruncatedNext(tool: string, idArg: string): string[] {
  return [
    `${tool} ${idArg} content_file=./content.md`,
    `${tool} ${idArg} full_content=true`,
  ];
}
