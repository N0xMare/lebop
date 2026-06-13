import { ValidationError } from "./errors.ts";
import { isIssueIdentifier, normalizeIssueIdentifier } from "./issueIdentifiers.ts";

export type WorkspacePathKind =
  | "root"
  | "teams"
  | "team"
  | "team_child"
  | "projects"
  | "project"
  | "project_child"
  | "initiatives"
  | "initiative"
  | "initiative_child"
  | "issues"
  | "issue"
  | "issue_child"
  | "agent_sessions"
  | "agent_session"
  | "documents"
  | "document"
  | "cycles"
  | "cycle"
  | "cycle_child"
  | "milestones"
  | "milestone"
  | "milestone_child";

export interface ParsedWorkspacePath {
  path: string;
  segments: string[];
  kind: WorkspacePathKind;
  id?: string;
  team?: string;
  child?: string;
}

const TEAM_CHILDREN = new Set(["issues", "projects", "cycles", "labels", "states", "members"]);
const PROJECT_CHILDREN = new Set(["issues", "documents", "updates", "milestones"]);
const INITIATIVE_CHILDREN = new Set(["projects", "updates"]);
const ISSUE_CHILDREN = new Set([
  "comments",
  "relations",
  "attachments",
  "agent-sessions",
  "documents",
]);
const CYCLE_CHILDREN = new Set(["issues"]);
const MILESTONE_CHILDREN = new Set(["issues"]);

export function normalizeWorkspacePath(input?: string | null): string {
  const raw = (input ?? "/").trim();
  if (raw === "" || raw === "." || raw === "linear:" || raw === "linear://") return "/";
  if (isIssueIdentifier(raw)) return `/issues/${normalizeIssueIdentifier(raw)}`;
  let path = raw
    .replace(/^linear:\/\/workspace\/current/i, "")
    .replace(/^linear:\/\//i, "")
    .replace(/^linear:/i, "");
  if (path === "") return "/";
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+/g, "/");
  if (path.length > 1) path = path.replace(/\/$/, "");
  const singleSegment = path.slice(1);
  if (!singleSegment.includes("/") && isIssueIdentifier(singleSegment)) {
    return `/issues/${normalizeIssueIdentifier(singleSegment)}`;
  }
  return path;
}

export function parseWorkspacePath(input?: string | null): ParsedWorkspacePath {
  const path = normalizeWorkspacePath(input);
  const segments = decodeWorkspacePathSegments(path);
  const [head, second, third] = segments;

  if (segments.length === 0) return { path, segments, kind: "root" };

  if (head === "teams") {
    if (segments.length === 1) return { path, segments, kind: "teams" };
    if (segments.length === 2 && second) return { path, segments, kind: "team", team: second };
    if (segments.length === 3 && second && third && TEAM_CHILDREN.has(third)) {
      return { path, segments, kind: "team_child", team: second, child: third };
    }
  }

  if (head === "projects") {
    if (segments.length === 1) return { path, segments, kind: "projects" };
    if (segments.length === 2 && second) return { path, segments, kind: "project", id: second };
    if (segments.length === 3 && second && third && PROJECT_CHILDREN.has(third)) {
      return { path, segments, kind: "project_child", id: second, child: third };
    }
  }

  if (head === "initiatives") {
    if (segments.length === 1) return { path, segments, kind: "initiatives" };
    if (segments.length === 2 && second) return { path, segments, kind: "initiative", id: second };
    if (segments.length === 3 && second && third && INITIATIVE_CHILDREN.has(third)) {
      return { path, segments, kind: "initiative_child", id: second, child: third };
    }
  }

  if (head === "issues") {
    if (segments.length === 1) return { path, segments, kind: "issues" };
    if (segments.length === 2 && second)
      return { path, segments, kind: "issue", id: second.toUpperCase() };
    if (segments.length === 3 && second && third && ISSUE_CHILDREN.has(third)) {
      return { path, segments, kind: "issue_child", id: second.toUpperCase(), child: third };
    }
  }

  if (head === "agent-sessions") {
    if (segments.length === 1) return { path, segments, kind: "agent_sessions" };
    if (segments.length === 2 && second)
      return { path, segments, kind: "agent_session", id: second };
  }

  if (head === "documents") {
    if (segments.length === 1) return { path, segments, kind: "documents" };
    if (segments.length === 2 && second) return { path, segments, kind: "document", id: second };
  }

  if (head === "cycles") {
    if (segments.length === 1) return { path, segments, kind: "cycles" };
    if (segments.length === 2 && second) return { path, segments, kind: "cycle", id: second };
    if (segments.length === 3 && second && third && CYCLE_CHILDREN.has(third)) {
      return { path, segments, kind: "cycle_child", id: second, child: third };
    }
  }

  if (head === "milestones") {
    if (segments.length === 1) return { path, segments, kind: "milestones" };
    if (segments.length === 2 && second) return { path, segments, kind: "milestone", id: second };
    if (segments.length === 3 && second && third && MILESTONE_CHILDREN.has(third)) {
      return { path, segments, kind: "milestone_child", id: second, child: third };
    }
  }
  throw new ValidationError(
    `unsupported Linear workspace path: ${path}`,
    "try /, /teams, /projects, /initiatives, /issues/<TEAM-NN>, /agent-sessions/<id>, or a next_path returned by explore_linear_workspace",
  );
}

function decodeWorkspacePathSegments(path: string): string[] {
  if (path === "/") return [];
  try {
    return path.slice(1).split("/").map(decodeURIComponent);
  } catch (err) {
    if (err instanceof URIError) {
      throw new ValidationError(
        `invalid percent encoding in Linear workspace path: ${path}`,
        "use a valid URL-encoded path segment, or pass the plain Linear id/key without percent escapes",
      );
    }
    throw err;
  }
}

export function childPaths(path: ParsedWorkspacePath): string[] {
  switch (path.kind) {
    case "root":
      return [
        "/teams",
        "/projects",
        "/initiatives",
        "/issues",
        "/agent-sessions",
        "/documents",
        "/cycles",
        "/milestones",
      ];
    case "team":
      return [
        `/teams/${path.team}/issues`,
        `/teams/${path.team}/projects`,
        `/teams/${path.team}/cycles`,
        `/teams/${path.team}/labels`,
        `/teams/${path.team}/states`,
        `/teams/${path.team}/members`,
      ];
    case "project":
      return [
        `/projects/${path.id}/issues`,
        `/projects/${path.id}/documents`,
        `/projects/${path.id}/updates`,
        `/projects/${path.id}/milestones`,
      ];
    case "initiative":
      return [`/initiatives/${path.id}/projects`, `/initiatives/${path.id}/updates`];
    case "issue":
      return [
        `/issues/${path.id}/comments`,
        `/issues/${path.id}/relations`,
        `/issues/${path.id}/attachments`,
        `/issues/${path.id}/agent-sessions`,
        `/issues/${path.id}/documents`,
      ];
    case "cycle":
      return [`/cycles/${path.id}/issues`];
    case "milestone":
      return [`/milestones/${path.id}/issues`];
    default:
      return [];
  }
}

export function safeSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
