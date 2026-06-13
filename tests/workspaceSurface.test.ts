import { describe, expect, it } from "vitest";
import {
  buildExploreWorkspaceInputFromCli,
  buildExploreWorkspaceInputFromMcp,
  buildFetchWorkspaceInputFromCli,
  buildFetchWorkspaceInputFromMcp,
  WORKSPACE_EXPLORE_SEARCH_KIND_INPUTS,
} from "../src/surface/index.ts";

describe("workspace surface contracts", () => {
  it("normalizes equivalent CLI and MCP explore inputs to the same canonical shape", () => {
    const cli = buildExploreWorkspaceInputFromCli({
      path: "/projects",
      opts: {
        query: "relayer",
        team: "NOX",
        kind: ["projects", "agent_sessions"],
        includeArchived: true,
        limit: 25,
        cursor: "cursor-1",
      },
    });
    const mcp = buildExploreWorkspaceInputFromMcp({
      path: "/projects",
      query: "relayer",
      team: "NOX",
      kinds: ["projects", "agent_sessions"],
      include_archived: true,
      limit: 25,
      cursor: "cursor-1",
    });

    expect(cli).toEqual(mcp);
    expect(cli).toEqual({
      path: "/projects",
      query: "relayer",
      team: "NOX",
      kinds: ["projects", "agent_sessions"],
      includeArchived: true,
      limit: 25,
      cursor: "cursor-1",
    });
  });

  it("applies root team context only to team-filterable CLI explore paths", () => {
    for (const path of [
      "/projects",
      "/issues",
      "/cycles",
      "/teams/NOX/projects",
      "/teams/NOX/cycles",
    ]) {
      expect(
        buildExploreWorkspaceInputFromCli({
          path,
          opts: {},
          context: { rootTeam: "NOX" },
        }).team,
      ).toBe("NOX");
    }

    for (const path of ["/", "/documents", "/initiatives", "/agent-sessions"]) {
      expect(
        buildExploreWorkspaceInputFromCli({
          path,
          opts: {},
          context: { rootTeam: "NOX" },
        }).team,
      ).toBeUndefined();
    }
  });

  it("applies root team context only to team-filterable CLI explore search kinds", () => {
    expect(
      buildExploreWorkspaceInputFromCli({
        opts: { query: "needle", kind: ["projects", "issues"] },
        context: { rootTeam: "NOX" },
      }).team,
    ).toBe("NOX");

    expect(
      buildExploreWorkspaceInputFromCli({
        opts: { query: "needle", kind: ["projects", "initiatives"] },
        context: { rootTeam: "NOX" },
      }).team,
    ).toBeUndefined();

    expect(
      buildExploreWorkspaceInputFromCli({
        opts: { query: "needle" },
        context: { rootTeam: "NOX" },
      }).team,
    ).toBeUndefined();
  });

  it("keeps explore kind aliases in the shared contract", () => {
    expect(WORKSPACE_EXPLORE_SEARCH_KIND_INPUTS).toEqual([
      "project",
      "projects",
      "issue",
      "issues",
      "initiative",
      "initiatives",
      "document",
      "documents",
      "cycle",
      "cycles",
      "milestone",
      "milestones",
      "agent-session",
      "agent-sessions",
      "agent_session",
      "agent_sessions",
    ]);
  });

  it("normalizes equivalent CLI and MCP fetch inputs to the same canonical shape", () => {
    const cli = buildFetchWorkspaceInputFromCli({
      target: "/issues/NOX-1",
      opts: {
        include: "comments,agent_sessions",
        depth: "full",
        limit: 50,
        cursor: "cursor-1",
        to: "/tmp/context",
      },
      context: { rootWorkspace: "noxor" },
    });
    const mcp = buildFetchWorkspaceInputFromMcp({
      target: "/issues/NOX-1",
      include: ["comments", "agent_sessions"],
      depth: "full",
      limit: 50,
      cursor: "cursor-1",
      to: "/tmp/context",
      workspace: "noxor",
    });

    expect(cli).toEqual(mcp);
    expect(cli).toEqual({
      target: "/issues/NOX-1",
      include: ["comments", "agent_sessions"],
      depth: "full",
      limit: 50,
      cursor: "cursor-1",
      to: "/tmp/context",
      workspace: "noxor",
    });
  });

  it("preserves omitted include versus explicit empty fetch include", () => {
    expect(
      buildFetchWorkspaceInputFromCli({
        target: "/issues/NOX-1",
        opts: {},
      }).include,
    ).toBeUndefined();

    expect(
      buildFetchWorkspaceInputFromCli({
        target: "/issues/NOX-1",
        opts: { include: "" },
      }).include,
    ).toEqual([""]);
  });
});
