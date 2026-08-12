import { describe, expect, it } from "vitest";
import { type ListedIssue, projectListedIssue } from "../src/lib/listIssues.ts";
import { isCoreTool } from "../src/lib/mcpProfiles.ts";
import {
  archiveNext,
  attachmentNext,
  bulkNext,
  diffNext,
  linkNext,
  listNext,
  mcpCacheStatusNext,
  mcpDiffNext,
  mcpPublishApplyNext,
  mcpPullNext,
  mcpPushNext,
  planApplyNext,
  planValidateNext,
  pullNext,
  pushNext,
  relationNext,
  setNext,
  showNext,
} from "../src/lib/nextStubs.ts";

describe("next stubs density", () => {
  it("setNext is ≤3 short stubs", () => {
    const n = setNext("TEAM-1", "state");
    expect(n.length).toBeLessThanOrEqual(3);
    expect(n[0]).toBe("show TEAM-1");
  });

  it("pull/push/archive/relation stubs are dense", () => {
    expect(pullNext().length).toBeLessThanOrEqual(3);
    expect(pushNext().length).toBeLessThanOrEqual(3);
    expect(archiveNext("archive").length).toBeLessThanOrEqual(3);
    expect(relationNext("add").length).toBeLessThanOrEqual(3);
    expect(mcpPullNext().length).toBeLessThanOrEqual(3);
    expect(mcpCacheStatusNext().length).toBeLessThanOrEqual(3);
  });

  it("mcpCacheStatusNext is exact, core-safe, and excludes full-only diff_issue", () => {
    expect(mcpCacheStatusNext()).toEqual(["pull_issues", "update_issue", "review_linear_changes"]);
    expect(mcpCacheStatusNext()).not.toContain("diff_issue");
    for (const name of mcpCacheStatusNext()) {
      expect(isCoreTool(name), `core-unsafe next stub: ${name}`).toBe(true);
    }
    for (const name of mcpPullNext()) {
      expect(isCoreTool(name), `core-unsafe pull next stub: ${name}`).toBe(true);
    }
  });

  it("listNext cursor form is short", () => {
    expect(listNext(true, "abc")).toEqual(["--cursor abc"]);
    expect(listNext(false, null).length).toBeGreaterThan(0);
  });

  it("showNext defaults without comments", () => {
    expect(showNext()[0]).toContain("comments");
  });

  it("showNext truncated prefers content-file then full-content", () => {
    const n = showNext({ truncated: true, identifier: "TEAM-1" });
    expect(n[0]).toContain("--content-file");
    expect(n[1]).toContain("--full-content");
  });

  it("mcp push/diff/publish-apply stubs are dense and core-safe where claimed", () => {
    expect(mcpPushNext().length).toBeLessThanOrEqual(3);
    expect(mcpDiffNext().length).toBeLessThanOrEqual(3);
    expect(mcpPublishApplyNext().length).toBeLessThanOrEqual(3);
    for (const name of mcpPublishApplyNext()) {
      expect(isCoreTool(name)).toBe(true);
    }
  });

  it("tertiary CLI stubs are dense (plan/diff/link/attachment/bulk)", () => {
    expect(planValidateNext().length).toBeLessThanOrEqual(3);
    expect(planApplyNext().length).toBeLessThanOrEqual(3);
    expect(diffNext().length).toBeLessThanOrEqual(3);
    expect(linkNext("T-1").length).toBeLessThanOrEqual(3);
    expect(attachmentNext("list").length).toBeLessThanOrEqual(3);
    expect(bulkNext().length).toBeLessThanOrEqual(3);
  });
});

describe("slim list assignee density", () => {
  const full: ListedIssue = {
    identifier: "A-1",
    title: "t",
    state: "Todo",
    state_type: "unstarted",
    priority: 2,
    assignee: { name: "Ada", email: "ada@x.com" },
    labels: [],
    updated_at: "2026-01-01T00:00:00.000Z",
    url: "https://linear.app/x",
    due_date: null,
  };

  it("default projection uses string assignee", () => {
    const slim = projectListedIssue(full);
    expect(slim.assignee).toBe("Ada");
  });

  it("full-like field set keeps structured assignee", () => {
    const slim = projectListedIssue(full, [
      "identifier",
      "title",
      "state",
      "state_type",
      "priority",
      "assignee",
      "labels",
      "updated_at",
      "url",
      "due_date",
    ]);
    expect(slim.assignee).toEqual({ name: "Ada", email: "ada@x.com" });
  });
});
