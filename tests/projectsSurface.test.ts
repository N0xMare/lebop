import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import {
  buildProjectCreateInputFromCli,
  buildProjectCreateInputFromMcp,
  buildProjectDeleteInputFromCli,
  buildProjectDeleteInputFromMcp,
  buildProjectListInputFromCli,
  buildProjectListInputFromMcp,
  buildProjectUpdateInputFromCli,
  buildProjectUpdateInputFromMcp,
  resolveProjectCreateTeamIds,
} from "../src/surface/projects.ts";

describe("project surface contracts", () => {
  it("normalizes equivalent CLI and MCP project list inputs", () => {
    const cli = buildProjectListInputFromCli({
      opts: {
        team: "NOX",
        state: "started",
        includeArchived: true,
        limit: "25",
        cursor: "project-cursor-1",
      },
    });
    const mcp = buildProjectListInputFromMcp({
      team: "NOX",
      state: "started",
      include_archived: true,
      limit: 25,
      cursor: "project-cursor-1",
    });

    expect(cli).toEqual(mcp);
    expect(cli).toEqual({
      team: "NOX",
      allTeams: undefined,
      state: "started",
      includeArchived: true,
      cursor: "project-cursor-1",
      max: 25,
    });
  });

  it("normalizes project list aliases and unlimited limits", () => {
    expect(
      buildProjectListInputFromCli({
        opts: { allTeams: true, includeArchived: true, limit: "0" },
      }),
    ).toEqual({
      team: undefined,
      allTeams: true,
      state: undefined,
      includeArchived: true,
      cursor: undefined,
      max: Number.POSITIVE_INFINITY,
    });

    expect(
      buildProjectListInputFromMcp({
        all_teams: true,
        include_archived: true,
        limit: 0,
      }),
    ).toEqual({
      team: undefined,
      allTeams: true,
      state: undefined,
      includeArchived: true,
      cursor: undefined,
      max: Number.POSITIVE_INFINITY,
    });
  });

  it("rejects project list cursors in explicit unbounded mode", () => {
    expect(() =>
      buildProjectListInputFromCli({
        opts: { limit: "0", cursor: "project-cursor-1" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buildProjectListInputFromMcp({
        limit: 0,
        cursor: "project-cursor-1",
      }),
    ).toThrow(ValidationError);
  });

  it("normalizes equivalent CLI and MCP project create selectors", async () => {
    const cli = buildProjectCreateInputFromCli({
      name: "Build It",
      opts: {
        team: "NOX",
        teamKey: ["NOX", "OPS"],
        teamId: ["team-nox"],
        description: "desc",
        content: "content",
        icon: "Rocket",
        state: "planned",
        startDate: "2026-06-01",
        targetDate: "2026-06-30",
      },
    });
    const mcp = buildProjectCreateInputFromMcp({
      name: "Build It",
      team: "NOX",
      team_keys: ["NOX", "OPS"],
      team_ids: ["team-nox"],
      description: "desc",
      content: "content",
      icon: "Rocket",
      state: "planned",
      start_date: "2026-06-01",
      target_date: "2026-06-30",
    });

    expect(cli).toEqual(mcp);
    const resolveTeamKeyToId = vi.fn(async (team: string) => `team-${team.toLowerCase()}`);
    const teamIds = await resolveProjectCreateTeamIds(cli, {
      defaultTeamKey: async () => "NOX",
      resolveTeamKeyToId,
    });

    expect(teamIds).toEqual(["team-nox", "team-ops"]);
    expect(resolveTeamKeyToId).toHaveBeenCalledTimes(2);
  });

  it("uses the default team selector only when create has no selectors", async () => {
    const input = buildProjectCreateInputFromMcp({ name: "Default Team Project" });
    const resolveTeamKeyToId = vi.fn(async (team: string) => `team-${team.toLowerCase()}`);

    await expect(
      resolveProjectCreateTeamIds(input, {
        defaultTeamKey: async () => "NOX",
        resolveTeamKeyToId,
      }),
    ).resolves.toEqual(["team-nox"]);
    expect(resolveTeamKeyToId).toHaveBeenCalledWith("NOX");
  });

  it("rejects empty explicit team ids before project create", async () => {
    const input = buildProjectCreateInputFromMcp({
      name: "Bad Team Id Project",
      team_ids: [" "],
    });

    await expect(
      resolveProjectCreateTeamIds(input, {
        defaultTeamKey: async () => "NOX",
        resolveTeamKeyToId: async (team) => `team-${team.toLowerCase()}`,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("normalizes CLI string nulls and MCP JSON nulls for project update", () => {
    const cli = buildProjectUpdateInputFromCli({
      id: "project-1",
      opts: {
        name: "Updated",
        icon: "null",
        startDate: "null",
        targetDate: "null",
      },
    });
    const mcp = buildProjectUpdateInputFromMcp({
      id: "project-1",
      name: "Updated",
      icon: null,
      start_date: null,
      target_date: null,
      repo_root: "/repo",
    });

    expect(cli).toEqual({
      id: "project-1",
      update: {
        name: "Updated",
        icon: null,
        startDate: null,
        targetDate: null,
      },
    });
    expect(mcp).toEqual({
      id: "project-1",
      update: {
        name: "Updated",
        icon: null,
        startDate: null,
        targetDate: null,
      },
      repoRoot: "/repo",
    });
  });

  it("rejects empty project updates before execution", () => {
    expect(() => buildProjectUpdateInputFromCli({ id: "project-1", opts: {} })).toThrow(
      ValidationError,
    );
    expect(() => buildProjectUpdateInputFromMcp({ id: "project-1" })).toThrow(ValidationError);
  });

  it("normalizes delete after medium-specific confirmation", () => {
    expect(buildProjectDeleteInputFromCli({ id: "project-1", opts: { yes: true } })).toEqual({
      id: "project-1",
    });
    expect(buildProjectDeleteInputFromMcp({ id: "project-1", confirm: true })).toEqual({
      id: "project-1",
    });
    expect(() => buildProjectDeleteInputFromCli({ id: "project-1", opts: {} })).toThrow(
      ValidationError,
    );
  });
});
