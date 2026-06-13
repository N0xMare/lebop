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
        team: "NOX",
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
      team: "NOX",
      project: "Agent Project",
      state_type: "started",
      assignee: "me",
      label: ["backend"],
      priority: 2,
      include_archived: true,
      limit: 25,
      cursor: "issue-cursor-1",
      workspace: "noxor",
    });

    expect(cli).toEqual(mcp);
    expect(cli).toMatchObject({
      team: "NOX",
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
      opts: { team: "NOX", limit: "0", cursor: "mine-cursor" },
    });
    const mcp = buildIssueListInputFromMcp({
      team: "NOX",
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
    expect(buildIssueGetInputFromCli({ id: "nox-1", opts: {} })).toEqual({
      identifier: "nox-1",
      includeComments: true,
      includeRelations: true,
    });
    expect(
      buildIssueGetInputFromMcp({
        identifier: "NOX-1",
        include_comments: false,
        include_relations: false,
        workspace: "noxor",
      }),
    ).toEqual({
      identifier: "NOX-1",
      includeComments: false,
      includeRelations: false,
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
    expect(() => buildIssueUpdateInputFromMcp({ identifier: "NOX-1" })).toThrow(
      "nothing to update",
    );
    expect(() =>
      buildIssueUpdateInputFromMcp({
        identifier: "NOX-1",
        labels_add: [],
        labels_remove: [],
      }),
    ).toThrow("nothing to update");
    expect(
      buildIssueUpdateInputFromMcp({
        identifier: "NOX-1",
        estimate: null,
        project: null,
        repo_root: "/repo/root",
      }),
    ).toMatchObject({
      identifier: "NOX-1",
      estimate: null,
      project: null,
      repoRoot: "/repo/root",
    });
  });

  it("normalizes update_issue label deltas and rejects mixed label modes", () => {
    expect(
      buildIssueUpdateInputFromMcp({
        identifier: "NOX-1",
        labels_add: ["type:feature"],
        labels_remove: ["type:bug"],
      }),
    ).toMatchObject({
      identifier: "NOX-1",
      labelDeltas: { add: ["type:feature"], remove: ["type:bug"] },
    });

    expect(() =>
      buildIssueUpdateInputFromMcp({
        identifier: "NOX-1",
        labels: ["type:feature"],
        labels_add: ["urgent"],
      }),
    ).toThrow("pass either labels or labels_add/labels_remove");
  });

  it("normalizes archive/unarchive ranges and destructive confirmation differences", () => {
    expect(() => buildIssueArchiveInputFromCli({ identifiers: ["NOX-1"], opts: {} })).toThrow(
      "refusing to archive issues without --yes",
    );

    expect(
      buildIssueArchiveInputFromCli({
        identifiers: ["nox-1..nox-2"],
        opts: { yes: true },
      }),
    ).toEqual({ identifiers: ["NOX-1", "NOX-2"], repoRoot: undefined });

    expect(
      buildIssueArchiveInputFromMcp({
        identifiers: ["NOX-3..NOX-4"],
        repo_root: "/repo/root",
      }),
    ).toEqual({ identifiers: ["NOX-3", "NOX-4"], repoRoot: "/repo/root" });

    expect(buildIssueUnarchiveInputFromCli({ identifiers: ["nox-5..nox-6"] })).toEqual({
      identifiers: ["NOX-5", "NOX-6"],
      repoRoot: undefined,
    });
    expect(
      buildIssueUnarchiveInputFromMcp({
        identifiers: ["NOX-7"],
        repo_root: "/repo/root",
      }),
    ).toEqual({ identifiers: ["NOX-7"], repoRoot: "/repo/root" });
  });

  it("normalizes bulk update CLI null strings and MCP cache context", () => {
    expect(
      buildIssueBulkUpdateInputFromCli({
        identifiers: ["NOX-1"],
        opts: {
          priority: "high",
          label: ["backend"],
          assignee: "null",
          estimate: "5",
          project: "null",
          milestone: "Roadmap",
          cycle: "null",
          team: "NOX",
          yes: true,
        },
        repoHash: "repo-hash",
        repoRoot: "/repo/root",
      }),
    ).toEqual({
      identifiers: ["NOX-1"],
      patch: {
        priority: "high",
        labels: ["backend"],
        assignee: null,
        estimate: 5,
        project: null,
        milestone: "Roadmap",
        cycle: null,
      },
      team: "NOX",
      repoHash: "repo-hash",
      repoRoot: "/repo/root",
    });

    expect(() =>
      buildIssueBulkUpdateInputFromCli({
        identifiers: ["NOX-1"],
        opts: { priority: "high" },
      }),
    ).toThrow(/without --yes/);

    expect(
      buildIssueBulkUpdateInputFromCli({
        identifiers: ["NOX-1"],
        opts: { priority: "high", dryRun: true },
      }),
    ).toMatchObject({
      identifiers: ["NOX-1"],
      patch: { priority: "high" },
      dryRun: true,
    });

    expect(
      buildIssueBulkUpdateInputFromMcp(
        {
          identifiers: ["NOX-2"],
          patch: { assignee: null, project: null },
          repo_root: "/repo/root",
        },
        {
          resolveCacheContext: (repoRoot) => ({
            repoRoot: repoRoot ?? null,
            repoHash: "repo-hash",
          }),
        },
      ),
    ).toEqual({
      identifiers: ["NOX-2"],
      patch: { assignee: null, project: null },
      team: undefined,
      repoHash: "repo-hash",
      repoRoot: "/repo/root",
    });
  });
});
