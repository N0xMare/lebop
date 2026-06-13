import { describe, expect, it } from "vitest";
import {
  childPaths,
  normalizeWorkspacePath,
  parseWorkspacePath,
} from "../src/lib/workspacePaths.ts";

describe("workspace paths", () => {
  it("normalizes Linear URI-ish paths", () => {
    expect(normalizeWorkspacePath("")).toBe("/");
    expect(normalizeWorkspacePath("projects/abc/")).toBe("/projects/abc");
    expect(normalizeWorkspacePath("linear://workspace/current/projects/abc")).toBe("/projects/abc");
    expect(normalizeWorkspacePath("nox-123")).toBe("/issues/NOX-123");
    expect(normalizeWorkspacePath("a1-42")).toBe("/issues/A1-42");
    expect(normalizeWorkspacePath("/nox-123")).toBe("/issues/NOX-123");
    expect(normalizeWorkspacePath("linear:nox-123")).toBe("/issues/NOX-123");
  });

  it("parses project, initiative, and issue child paths", () => {
    expect(parseWorkspacePath("/projects/project-1/issues")).toMatchObject({
      kind: "project_child",
      id: "project-1",
      child: "issues",
    });
    expect(parseWorkspacePath("/initiatives/init-1/updates")).toMatchObject({
      kind: "initiative_child",
      id: "init-1",
      child: "updates",
    });
    expect(parseWorkspacePath("/issues/nox-1/comments")).toMatchObject({
      kind: "issue_child",
      id: "NOX-1",
      child: "comments",
    });
    expect(parseWorkspacePath("/cycles/cycle-1/issues")).toMatchObject({
      kind: "cycle_child",
      id: "cycle-1",
      child: "issues",
    });
    expect(parseWorkspacePath("/milestones/milestone-1/issues")).toMatchObject({
      kind: "milestone_child",
      id: "milestone-1",
      child: "issues",
    });
    expect(parseWorkspacePath("/agent-sessions/session-1")).toMatchObject({
      kind: "agent_session",
      id: "session-1",
    });
    expect(parseWorkspacePath("/issues/nox-1/agent-sessions")).toMatchObject({
      kind: "issue_child",
      id: "NOX-1",
      child: "agent-sessions",
    });
    expect(parseWorkspacePath("/issues/nox-1/documents")).toMatchObject({
      kind: "issue_child",
      id: "NOX-1",
      child: "documents",
    });
  });

  it("returns fetchable next paths for concrete parents", () => {
    expect(childPaths(parseWorkspacePath("/projects/project-1"))).toEqual([
      "/projects/project-1/issues",
      "/projects/project-1/documents",
      "/projects/project-1/updates",
      "/projects/project-1/milestones",
    ]);
    expect(childPaths(parseWorkspacePath("/cycles/cycle-1"))).toEqual(["/cycles/cycle-1/issues"]);
    expect(childPaths(parseWorkspacePath("/milestones/milestone-1"))).toEqual([
      "/milestones/milestone-1/issues",
    ]);
    expect(childPaths(parseWorkspacePath("/issues/NOX-1"))).toContain(
      "/issues/NOX-1/agent-sessions",
    );
    expect(childPaths(parseWorkspacePath("/issues/NOX-1"))).toContain("/issues/NOX-1/documents");
  });

  it("rejects invalid percent escapes with a structured validation message", () => {
    expect(() => parseWorkspacePath("/issues/%E0%A4%A/comments")).toThrow(
      "invalid percent encoding in Linear workspace path",
    );
  });
});
