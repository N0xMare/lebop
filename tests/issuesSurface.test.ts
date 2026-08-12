import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import {
  buildIssueArchiveInputFromCli,
  buildIssueArchiveInputFromMcp,
  buildIssueBulkUpdateInputFromCli,
  buildIssueBulkUpdateInputFromMcp,
  buildIssueCreateInputFromCli,
  buildIssueCreateInputFromMcp,
  buildIssueGetInputFromCli,
  buildIssueGetInputFromMcp,
  buildIssueListInputFromCli,
  buildIssueListInputFromMcp,
  buildIssueMineInputFromCli,
  buildIssueUnarchiveInputFromCli,
  buildIssueUnarchiveInputFromMcp,
  buildIssueUpdateInputFromMcp,
} from "../src/surface/issues.ts";

describe("issues surface contracts", () => {
  it("normalizes equivalent CLI and MCP issue list inputs", () => {
    const cli = buildIssueListInputFromCli({
      opts: {
        team: "TEAM",
        project: "Agent Project",
        stateType: "started",
        assignee: "me",
        label: ["backend"],
        priority: "2",
        includeArchived: true,
        limit: "25",
        cursor: "issue-cursor-1",
      },
    });
    const mcp = buildIssueListInputFromMcp({
      team: "TEAM",
      project: "Agent Project",
      state_type: "started",
      assignee: "me",
      label: ["backend"],
      priority: 2,
      include_archived: true,
      limit: 25,
      cursor: "issue-cursor-1",
      workspace: "acme",
    });

    expect(cli).toEqual(mcp);
    expect(cli).toMatchObject({
      team: "TEAM",
      project: "Agent Project",
      stateType: "started",
      assignee: "me",
      label: ["backend"],
      priority: 2,
      includeArchived: true,
      max: 25,
      cursor: "issue-cursor-1",
    });
  });

  it("normalizes mine and MCP active_only to the same active state preset", () => {
    const mine = buildIssueMineInputFromCli({
      opts: { team: "TEAM", limit: "0", cursor: "mine-cursor" },
    });
    const mcp = buildIssueListInputFromMcp({
      team: "TEAM",
      assignee: "me",
      active_only: true,
      limit: 0,
      cursor: "mine-cursor",
    });

    expect(mine).toEqual(mcp);
    expect(mine).toMatchObject({
      assignee: "me",
      stateTypeIn: ["triage", "backlog", "unstarted", "started"],
      max: Number.POSITIVE_INFINITY,
    });
  });

  it("keeps issue list validation loud at the surface boundary", () => {
    expect(() => buildIssueListInputFromCli({ opts: { priority: "99" } })).toThrow(
      'invalid --priority value "99"',
    );
    expect(() =>
      buildIssueListInputFromMcp({
        state_type: "started",
        state_type_in: ["backlog"],
      }),
    ).toThrow(ValidationError);
  });

  it("normalizes show/get_issue defaults without leaking workspace into canonical input", () => {
    // 0.0.6 dense defaults: comments off; CLI keeps relations on for shell.
    expect(buildIssueGetInputFromCli({ id: "team-1", opts: {} })).toEqual({
      identifier: "team-1",
      includeComments: false,
      includeRelations: true,
      fullContent: false,
    });
    expect(
      buildIssueGetInputFromMcp({
        identifier: "TEAM-1",
        include_comments: false,
        include_relations: false,
        workspace: "acme",
      }),
    ).toEqual({
      identifier: "TEAM-1",
      includeComments: false,
      includeRelations: false,
      fullContent: false,
    });
    expect(
      buildIssueGetInputFromMcp({
        identifier: "TEAM-1",
        include_comments: true,
        include_relations: true,
      }),
    ).toEqual({
      identifier: "TEAM-1",
      includeComments: true,
      includeRelations: true,
      fullContent: false,
    });
  });

  it("preserves create_issue project selector exclusivity for CLI and MCP", () => {
    expect(() =>
      buildIssueCreateInputFromCli({
        opts: { title: "Bad selector", project: "By Name", projectId: "project-uuid" },
      }),
    ).toThrow("pass exactly one of --project / --project-id");
    expect(() =>
      buildIssueCreateInputFromMcp({
        title: "Bad selector",
        project: "By Name",
        project_id: "project-uuid",
      }),
    ).toThrow("create_issue accepts either project or project_id");
  });

  it("normalizes CLI issue create estimate to the canonical create input", () => {
    expect(
      buildIssueCreateInputFromCli({
        opts: { title: "Estimated issue", estimate: "5" },
      }),
    ).toMatchObject({
      title: "Estimated issue",
      estimate: 5,
    });
  });

  it("rejects empty update_issue inputs before execution", () => {
    expect(() => buildIssueUpdateInputFromMcp({ identifier: "TEAM-1" })).toThrow(
      "nothing to update",
    );
    expect(() =>
      buildIssueUpdateInputFromMcp({
        identifier: "TEAM-1",
        labels_add: [],
        labels_remove: [],
      }),
    ).toThrow("nothing to update");
    expect(
      buildIssueUpdateInputFromMcp({
        identifier: "TEAM-1",
        estimate: null,
        project: null,
        repo_root: "/repo/root",
      }),
    ).toMatchObject({
      identifier: "TEAM-1",
      estimate: null,
      project: null,
      repoRoot: "/repo/root",
    });
  });

  it("normalizes update_issue label deltas and rejects mixed label modes", () => {
    expect(
      buildIssueUpdateInputFromMcp({
        identifier: "TEAM-1",
        labels_add: ["type:feature"],
        labels_remove: ["type:bug"],
      }),
    ).toMatchObject({
      identifier: "TEAM-1",
      labelDeltas: { add: ["type:feature"], remove: ["type:bug"] },
    });

    expect(() =>
      buildIssueUpdateInputFromMcp({
        identifier: "TEAM-1",
        labels: ["type:feature"],
        labels_add: ["urgent"],
      }),
    ).toThrow("pass either labels or labels_add/labels_remove");
  });

  it("normalizes archive/unarchive ranges and destructive confirmation differences", () => {
    expect(() => buildIssueArchiveInputFromCli({ identifiers: ["TEAM-1"], opts: {} })).toThrow(
      "refusing to archive issues without --yes",
    );

    expect(
      buildIssueArchiveInputFromCli({
        identifiers: ["team-1..team-2"],
        opts: { yes: true },
      }),
    ).toEqual({ identifiers: ["TEAM-1", "TEAM-2"], confirmed: true });

    expect(
      buildIssueArchiveInputFromMcp({
        identifiers: ["TEAM-3..TEAM-4"],
        repo_root: "/repo/root",
        confirm: true,
      }),
    ).toEqual({ identifiers: ["TEAM-3", "TEAM-4"], repoRoot: "/repo/root", confirmed: true });

    expect(() =>
      buildIssueArchiveInputFromMcp({
        identifiers: ["TEAM-3"],
        repo_root: "/repo/root",
      }),
    ).toThrow(/confirm:true/);

    expect(buildIssueUnarchiveInputFromCli({ identifiers: ["team-5..team-6"] })).toEqual({
      identifiers: ["TEAM-5", "TEAM-6"],
      repoRoot: undefined,
    });
    expect(
      buildIssueUnarchiveInputFromMcp({
        identifiers: ["TEAM-7"],
        repo_root: "/repo/root",
      }),
    ).toEqual({ identifiers: ["TEAM-7"], repoRoot: "/repo/root" });
  });

  it("normalizes bulk update CLI null strings and MCP cache context", () => {
    expect(
      buildIssueBulkUpdateInputFromCli({
        identifiers: ["TEAM-1"],
        opts: {
          priority: "high",
          label: ["backend"],
          assignee: "null",
          estimate: "5",
          project: "null",
          milestone: "Roadmap",
          cycle: "null",
          team: "TEAM",
          yes: true,
        },
        repoHash: "repo-hash",
        repoRoot: "/repo/root",
      }),
    ).toEqual({
      identifiers: ["TEAM-1"],
      patch: {
        priority: "high",
        labels: ["backend"],
        assignee: null,
        estimate: 5,
        project: null,
        milestone: "Roadmap",
        cycle: null,
      },
      team: "TEAM",
      confirmed: true,
      repoHash: "repo-hash",
      repoRoot: "/repo/root",
    });

    expect(() =>
      buildIssueBulkUpdateInputFromCli({
        identifiers: ["TEAM-1"],
        opts: { priority: "high" },
      }),
    ).toThrow(/without --yes/);

    expect(
      buildIssueBulkUpdateInputFromCli({
        identifiers: ["TEAM-1"],
        opts: { priority: "high", dryRun: true },
      }),
    ).toMatchObject({
      identifiers: ["TEAM-1"],
      patch: { priority: "high" },
      dryRun: true,
    });

    expect(
      buildIssueBulkUpdateInputFromMcp(
        {
          identifiers: ["TEAM-2"],
          patch: { assignee: null, project: null },
          repo_root: "/repo/root",
          confirm: true,
        },
        {
          resolveCacheContext: (repoRoot) => ({
            repoRoot: repoRoot ?? null,
            repoHash: "repo-hash",
          }),
        },
      ),
    ).toEqual({
      identifiers: ["TEAM-2"],
      patch: { assignee: null, project: null },
      team: undefined,
      confirmed: true,
      repoHash: "repo-hash",
      repoRoot: "/repo/root",
    });
  });
});
