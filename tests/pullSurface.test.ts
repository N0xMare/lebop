import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import { PullOverwriteConflictError } from "../src/lib/pullOperations.ts";
import {
  buildPullIssuesInputFromCli,
  buildPullIssuesInputFromMcp,
  buildPullProjectInputFromCli,
  buildPullProjectInputFromMcp,
} from "../src/surface/pull.ts";

describe("pull surface contracts", () => {
  it("reports MCP refresh recovery with the required confirm flag", () => {
    const err = new PullOverwriteConflictError(["NOX-1"]);

    expect(err.hint).toContain("refresh=true");
    expect(err.hint).toContain("confirm=true");
  });

  it("normalizes CLI issue pulls without MCP cache-path or repo-root behavior", () => {
    expect(
      buildPullIssuesInputFromCli({
        ids: ["NOX-1", "NOX-2"],
        opts: {
          team: "NOX",
          refresh: true,
          comments: false,
          to: "out",
        },
      }),
    ).toEqual({
      identifiers: ["NOX-1", "NOX-2"],
      team: "NOX",
      refresh: true,
      includeComments: false,
      to: "out",
      includeCachePath: false,
    });
  });

  it("normalizes MCP issue pulls with identifier-derived team and repo-root validation", () => {
    const input = buildPullIssuesInputFromMcp({
      identifiers: ["UE-10..UE-11"],
      repo_root: "/repo/root",
      refresh: true,
      include_comments: false,
      to: "out",
      workspace: "noxor",
    });

    expect(input).toEqual({
      identifiers: ["UE-10..UE-11"],
      repoRoot: "/repo/root",
      team: undefined,
      refresh: true,
      includeComments: false,
      to: "out",
      deriveTeamFromIdentifiers: true,
      requireGitRoot: true,
      includeCachePath: true,
    });
    expect("workspace" in input).toBe(false);
  });

  it("rejects empty MCP issue pulls at the surface boundary", () => {
    expect(() => buildPullIssuesInputFromMcp({ identifiers: [] })).toThrow(ValidationError);
  });

  it("normalizes CLI project pulls with strict selector handling", () => {
    expect(
      buildPullProjectInputFromCli({
        ids: ["NOX-5"],
        opts: {
          team: "NOX",
          project: "Ignored When Project ID Is Present",
          projectId: "11111111-2222-4333-8444-555555555555",
          comments: true,
        },
      }),
    ).toEqual({
      project: "Ignored When Project ID Is Present",
      projectId: "11111111-2222-4333-8444-555555555555",
      extraIdentifiers: ["NOX-5"],
      team: "NOX",
      refresh: false,
      includeComments: true,
      to: undefined,
      includeCachePath: false,
      strictProjectSelector: true,
    });
  });

  it("normalizes MCP project pulls for strict selector handling and cache-path output", () => {
    expect(
      buildPullProjectInputFromMcp({
        project: "Target Project",
        project_id: "11111111-2222-4333-8444-555555555555",
        repo_root: "/repo/root",
        team: "UE",
        extra_identifiers: ["UE-20..UE-21"],
        include_comments: false,
        workspace: "noxor",
      }),
    ).toEqual({
      project: "Target Project",
      projectId: "11111111-2222-4333-8444-555555555555",
      extraIdentifiers: ["UE-20..UE-21"],
      repoRoot: "/repo/root",
      team: "UE",
      refresh: false,
      includeComments: false,
      to: undefined,
      requireGitRoot: true,
      includeCachePath: true,
      strictProjectSelector: true,
    });
  });
});
