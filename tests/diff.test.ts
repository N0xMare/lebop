import { describe, expect, it } from "vitest";
import { type IssueMetadata, type ProjectMetadata, sha256 } from "../src/lib/cache.ts";
import {
  diffIssueFields,
  diffIssueMetadata,
  diffProjectFields,
  diffProjectMetadata,
} from "../src/lib/diff.ts";

function issueFixture(desc: string): IssueMetadata {
  return {
    identifier: "UE-1",
    title: "original title",
    state: "Backlog",
    priority: 0,
    estimate: null,
    labels: ["type:test"],
    assignee: "alice@example.com",
    project: "Example",
    milestone: null,
    cycle: null,
    parent: null,
    _server: {
      id: "u-1",
      identifier: "UE-1",
      url: "https://linear.app/x/issue/UE-1",
      state_id: "s-backlog",
      state_name: "Backlog",
      state_type: "backlog",
      priority: 0,
      estimate: null,
      label_ids: [{ id: "l-1", name: "type:test" }],
      assignee_id: "m-1",
      assignee_name: "alice",
      assignee_email: "alice@example.com",
      title: "original title",
      description_hash: sha256(desc),
      project_id: "p-1",
      project_name: "Example",
      project_milestone_id: null,
      project_milestone_name: null,
      cycle_id: null,
      cycle_name: null,
      parent_id: null,
      parent_identifier: null,
      updated_at: "2026-04-23T00:00:00.000Z",
    },
  };
}

describe("diffIssueMetadata", () => {
  it("returns no changes when local matches _server", () => {
    const desc = "hello world";
    expect(diffIssueMetadata(issueFixture(desc), desc)).toEqual([]);
  });

  it("detects title change", () => {
    const meta = issueFixture("body");
    meta.title = "new title";
    const changes = diffIssueMetadata(meta, "body");
    expect(changes).toEqual([{ field: "title", from: "original title", to: "new title" }]);
  });

  it("detects description change via hash mismatch", () => {
    const meta = issueFixture("old body");
    const changes = diffIssueMetadata(meta, "new body");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.field).toBe("description");
  });

  it("detects state change", () => {
    const meta = issueFixture("body");
    meta.state = "In Progress";
    const changes = diffIssueMetadata(meta, "body");
    expect(changes.find((c) => c.field === "state")).toEqual({
      field: "state",
      from: "Backlog",
      to: "In Progress",
    });
  });

  it("detects priority change", () => {
    const meta = issueFixture("body");
    meta.priority = 1;
    const changes = diffIssueMetadata(meta, "body");
    expect(changes.find((c) => c.field === "priority")).toEqual({
      field: "priority",
      from: 0,
      to: 1,
    });
  });

  it("ignores label-order differences", () => {
    const meta = issueFixture("body");
    meta._server.label_ids = [
      { id: "l-1", name: "type:test" },
      { id: "l-2", name: "priority:p1" },
    ];
    meta.labels = ["priority:p1", "type:test"];
    expect(diffIssueMetadata(meta, "body")).toEqual([]);
  });

  it("detects estimate add", () => {
    const meta = issueFixture("body");
    meta.estimate = 5;
    const changes = diffIssueMetadata(meta, "body");
    expect(changes.find((c) => c.field === "estimate")).toEqual({
      field: "estimate",
      from: null,
      to: 5,
    });
  });

  it("detects estimate change", () => {
    const meta = issueFixture("body");
    meta._server.estimate = 3;
    meta.estimate = 8;
    const changes = diffIssueMetadata(meta, "body");
    expect(changes.find((c) => c.field === "estimate")).toEqual({
      field: "estimate",
      from: 3,
      to: 8,
    });
  });

  it("detects estimate clear", () => {
    const meta = issueFixture("body");
    meta._server.estimate = 5;
    meta.estimate = null;
    const changes = diffIssueMetadata(meta, "body");
    expect(changes.find((c) => c.field === "estimate")).toEqual({
      field: "estimate",
      from: 5,
      to: null,
    });
  });

  it("detects parent add", () => {
    const meta = issueFixture("body");
    meta.parent = "UE-100";
    const changes = diffIssueMetadata(meta, "body");
    expect(changes.find((c) => c.field === "parent")).toEqual({
      field: "parent",
      from: null,
      to: "UE-100",
    });
  });

  it("detects parent change", () => {
    const meta = issueFixture("body");
    meta._server.parent_identifier = "UE-100";
    meta._server.parent_id = "u-100";
    meta.parent = "UE-200";
    const changes = diffIssueMetadata(meta, "body");
    expect(changes.find((c) => c.field === "parent")).toEqual({
      field: "parent",
      from: "UE-100",
      to: "UE-200",
    });
  });

  it("ignores parent unchanged", () => {
    const meta = issueFixture("body");
    meta._server.parent_identifier = "UE-100";
    meta.parent = "UE-100";
    expect(diffIssueMetadata(meta, "body").find((c) => c.field === "parent")).toBeUndefined();
  });

  it("detects project, milestone, and cycle placement changes", () => {
    const meta = issueFixture("body");
    meta.project = "New Project";
    meta.milestone = "M1";
    meta.cycle = "Cycle 1";
    const changes = diffIssueMetadata(meta, "body");
    expect(changes).toEqual(
      expect.arrayContaining([
        { field: "project", from: "Example", to: "New Project" },
        { field: "milestone", from: null, to: "M1" },
        { field: "cycle", from: null, to: "Cycle 1" },
      ]),
    );
  });

  it("detects label add", () => {
    const meta = issueFixture("body");
    meta.labels = ["type:test", "priority:p0"];
    const changes = diffIssueMetadata(meta, "body");
    const labelChange = changes.find((c) => c.field === "labels");
    expect(labelChange).toBeDefined();
    expect(labelChange?.to).toEqual(["priority:p0", "type:test"]);
    expect(labelChange?.from).toEqual(["type:test"]);
  });

  it("detects label removal", () => {
    const meta = issueFixture("body");
    meta.labels = [];
    const changes = diffIssueMetadata(meta, "body");
    expect(changes.find((c) => c.field === "labels")).toBeDefined();
  });

  it("detects assignee clear", () => {
    const meta = issueFixture("body");
    meta.assignee = null;
    const changes = diffIssueMetadata(meta, "body");
    expect(changes.find((c) => c.field === "assignee")).toEqual({
      field: "assignee",
      from: "alice@example.com",
      to: null,
    });
  });

  it("treats null and undefined assignee as equal", () => {
    const meta = issueFixture("body");
    meta.assignee = null;
    meta._server.assignee_email = null;
    meta._server.assignee_name = null;
    expect(diffIssueMetadata(meta, "body")).toEqual([]);
  });
});

describe("diffIssueFields", () => {
  it("detects remote placement drift for project, milestone, and cycle", () => {
    const local = issueFixture("body");
    const remote = issueFixture("body");
    local.project = "Local Project";
    local.milestone = "Local Milestone";
    local.cycle = "Local Cycle";
    remote.project = "Remote Project";
    remote.milestone = null;
    remote.cycle = "Remote Cycle";

    expect(diffIssueFields(local, remote)).toEqual(
      expect.arrayContaining([
        { field: "project", local: "Local Project", remote: "Remote Project" },
        { field: "milestone", local: "Local Milestone", remote: null },
        { field: "cycle", local: "Local Cycle", remote: "Remote Cycle" },
      ]),
    );
  });
});

function projectFixture(content: string): ProjectMetadata {
  return {
    name: "Example",
    description: "short tagline",
    icon: null,
    start_date: null,
    target_date: null,
    state: "started",
    _server: {
      id: "p-1",
      url: "https://linear.app/x/project/example",
      state: "started",
      name: "Example",
      description: "short tagline",
      icon: null,
      start_date: null,
      target_date: null,
      content_hash: sha256(content),
      updated_at: "2026-04-23T00:00:00.000Z",
    },
  };
}

describe("diffProjectMetadata", () => {
  it("returns no changes when local matches _server", () => {
    const content = "body";
    expect(diffProjectMetadata(projectFixture(content), content)).toEqual([]);
  });

  it("detects name change", () => {
    const meta = projectFixture("body");
    meta.name = "Renamed";
    const changes = diffProjectMetadata(meta, "body");
    expect(changes.find((c) => c.field === "name")).toEqual({
      field: "name",
      from: "Example",
      to: "Renamed",
    });
  });

  it("detects content change via hash mismatch", () => {
    const meta = projectFixture("old");
    const changes = diffProjectMetadata(meta, "new");
    expect(changes.find((c) => c.field === "content")).toBeDefined();
  });

  it("detects icon change", () => {
    const meta = projectFixture("body");
    meta.icon = "Rocket";
    expect(diffProjectMetadata(meta, "body").find((c) => c.field === "icon")).toEqual({
      field: "icon",
      from: null,
      to: "Rocket",
    });
  });

  it("detects icon clear", () => {
    const meta = projectFixture("body");
    meta._server.icon = "Rocket";
    meta.icon = null;
    expect(diffProjectMetadata(meta, "body").find((c) => c.field === "icon")).toEqual({
      field: "icon",
      from: "Rocket",
      to: null,
    });
  });

  it("detects project date changes", () => {
    const meta = projectFixture("body");
    meta.start_date = "2026-06-01";
    meta.target_date = "2026-06-30";
    expect(diffProjectMetadata(meta, "body")).toEqual(
      expect.arrayContaining([
        { field: "start_date", from: null, to: "2026-06-01" },
        { field: "target_date", from: null, to: "2026-06-30" },
      ]),
    );
  });

  it("detects state change", () => {
    const meta = projectFixture("body");
    meta.state = "completed";
    expect(diffProjectMetadata(meta, "body").find((c) => c.field === "state")).toEqual({
      field: "state",
      from: "started",
      to: "completed",
    });
  });
});

describe("diffProjectFields", () => {
  it("does not report date drift when local and remote project dates match", () => {
    const local = projectFixture("body");
    const remote = projectFixture("body");
    local.start_date = "2026-06-01";
    local.target_date = "2026-06-30";
    remote.start_date = "2026-06-01";
    remote.target_date = "2026-06-30";

    expect(diffProjectFields(local, remote)).toEqual([]);
  });
});
