import { describe, expect, it } from "vitest";
import { type IssueMetadata, type ProjectMetadata, sha256 } from "../src/lib/cache.ts";
import { diffIssueMetadata, diffProjectMetadata } from "../src/lib/diff.ts";

function issueFixture(desc: string): IssueMetadata {
  return {
    identifier: "UE-1",
    title: "original title",
    state: "Backlog",
    priority: 0,
    labels: ["type:test"],
    assignee: "alice@example.com",
    project: "Example",
    _server: {
      id: "u-1",
      identifier: "UE-1",
      url: "https://linear.app/x/issue/UE-1",
      state_id: "s-backlog",
      state_name: "Backlog",
      state_type: "backlog",
      priority: 0,
      label_ids: [{ id: "l-1", name: "type:test" }],
      assignee_id: "m-1",
      assignee_name: "alice",
      assignee_email: "alice@example.com",
      title: "original title",
      description_hash: sha256(desc),
      project_id: "p-1",
      project_name: "Example",
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

function projectFixture(content: string): ProjectMetadata {
  return {
    name: "Example",
    description: "short tagline",
    state: "started",
    _server: {
      id: "p-1",
      url: "https://linear.app/x/project/example",
      state: "started",
      name: "Example",
      description: "short tagline",
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
