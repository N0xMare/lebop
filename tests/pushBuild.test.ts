/**
 * Wave-2 / item #7 — `buildIssueUpdateInput` is now a shared lib export so
 * the MCP `push_changes` tool and the CLI `lebop push` both apply the exact
 * same field-resolution behavior. These tests assert the per-field
 * translation against synthetic team metadata, plus the parent-id lookup
 * path that requires a Linear SDK round-trip.
 */

import { describe, expect, it, vi } from "vitest";
import type { IssueMetadata, TeamMetadata } from "../src/lib/cache.ts";
import type { IssueChange } from "../src/lib/diff.ts";
import { NotFoundError } from "../src/lib/errors.ts";

// Mock the SDK so the parent-id lookup path is deterministic. Other field
// paths don't need it.
const mockIssueImpl = vi.fn();
vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      issue: (id: string) => mockIssueImpl(id),
      client: { rawRequest: vi.fn() },
      viewer: Promise.resolve({ id: "viewer-uuid" }),
    }),
}));

import { buildIssueUpdateInput, type IssuePushPlan } from "../src/lib/pushBuild.ts";

const teamMetadata: TeamMetadata = {
  team_id: "team-1",
  team_key: "UE",
  fetched_at: new Date().toISOString(),
  states: [
    { id: "state-todo", name: "Todo", type: "unstarted" },
    { id: "state-done", name: "Done", type: "completed" },
  ],
  labels: [
    { id: "label-bug", name: "bug" },
    { id: "label-feat", name: "feature" },
  ],
  members: [{ id: "user-alice", name: "Alice", email: "alice@example.com" }],
  projects: [{ id: "proj-1", name: "Example", state: "started" }],
};

function makeMetadata(overrides: Partial<IssueMetadata>): IssueMetadata {
  return {
    identifier: "UE-1",
    title: overrides.title ?? "t",
    state: overrides.state ?? "Todo",
    priority: overrides.priority ?? 0,
    estimate: overrides.estimate ?? null,
    labels: overrides.labels ?? [],
    assignee: overrides.assignee ?? null,
    project: overrides.project ?? null,
    parent: overrides.parent ?? null,
    _server: {
      id: "issue-uuid",
      identifier: "UE-1",
      url: "https://linear.app/x/issue/UE-1",
      state_id: "state-todo",
      state_name: "Todo",
      state_type: "unstarted",
      priority: 0,
      estimate: null,
      label_ids: [],
      assignee_id: null,
      assignee_name: null,
      assignee_email: null,
      title: "t",
      description_hash: "h",
      project_id: null,
      project_name: null,
      parent_id: null,
      parent_identifier: null,
      updated_at: new Date().toISOString(),
    },
  };
}

function planFor(
  changes: IssueChange[],
  metadata: Partial<IssueMetadata>,
  description = "",
): IssuePushPlan {
  return {
    identifier: "UE-1",
    description,
    changes,
    metadata: makeMetadata(metadata),
  };
}

describe("buildIssueUpdateInput", () => {
  it("translates title + description changes", async () => {
    const input = await buildIssueUpdateInput(
      planFor(
        [
          { field: "title", from: "old", to: "new" },
          { field: "description", from: "", to: "body" },
        ],
        { title: "new" },
        "body",
      ),
      teamMetadata,
    );
    expect(input).toEqual({ title: "new", description: "body" });
  });

  it("resolves state name to UUID", async () => {
    const input = await buildIssueUpdateInput(
      planFor([{ field: "state", from: "Todo", to: "Done" }], { state: "Done" }),
      teamMetadata,
    );
    expect(input).toEqual({ stateId: "state-done" });
  });

  it("resolves labels to UUID list", async () => {
    const input = await buildIssueUpdateInput(
      planFor([{ field: "labels", from: [], to: ["bug", "feature"] }], {
        labels: ["bug", "feature"],
      }),
      teamMetadata,
    );
    expect(input).toEqual({ labelIds: ["label-bug", "label-feat"] });
  });

  it("resolves assignee email to UUID", async () => {
    const input = await buildIssueUpdateInput(
      planFor([{ field: "assignee", from: null, to: "alice@example.com" }], {
        assignee: "alice@example.com",
      }),
      teamMetadata,
    );
    expect(input).toEqual({ assigneeId: "user-alice" });
  });

  it("clears assignee on null metadata", async () => {
    const input = await buildIssueUpdateInput(
      planFor([{ field: "assignee", from: "alice", to: null }], { assignee: null }),
      teamMetadata,
    );
    expect(input).toEqual({ assigneeId: null });
  });

  it("passes priority + estimate through", async () => {
    const input = await buildIssueUpdateInput(
      planFor(
        [
          { field: "priority", from: 0, to: 2 },
          { field: "estimate", from: null, to: 5 },
        ],
        { priority: 2, estimate: 5 },
      ),
      teamMetadata,
    );
    expect(input).toEqual({ priority: 2, estimate: 5 });
  });

  it("resolves parent identifier to UUID via SDK lookup", async () => {
    mockIssueImpl.mockResolvedValueOnce({ id: "parent-uuid", identifier: "UE-9" });
    const input = await buildIssueUpdateInput(
      planFor([{ field: "parent", from: null, to: "UE-9" }], { parent: "UE-9" }),
      teamMetadata,
    );
    expect(input).toEqual({ parentId: "parent-uuid" });
    expect(mockIssueImpl).toHaveBeenCalledWith("UE-9");
  });

  it("clears parent on null metadata", async () => {
    const input = await buildIssueUpdateInput(
      planFor([{ field: "parent", from: "UE-9", to: null }], { parent: null }),
      teamMetadata,
    );
    expect(input).toEqual({ parentId: null });
  });

  it("throws on unresolvable parent identifier", async () => {
    mockIssueImpl.mockResolvedValueOnce(null);
    await expect(
      buildIssueUpdateInput(
        planFor([{ field: "parent", from: null, to: "UE-404" }], { parent: "UE-404" }),
        teamMetadata,
      ),
    ).rejects.toThrow(/parent issue not found/);
  });

  // Wave-4 round-B item #1: the unresolvable-parent throw is now a
  // structured NotFoundError (was a raw Error). MCP clients now see
  // `code: "not_found"` and a hint that names the identifier the caller
  // passed, instead of a generic `code: "unknown"`.
  it("throws NotFoundError with code=not_found + hint naming the identifier", async () => {
    mockIssueImpl.mockResolvedValueOnce(null);
    const err = await buildIssueUpdateInput(
      planFor([{ field: "parent", from: null, to: "UE-404" }], { parent: "UE-404" }),
      teamMetadata,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("not_found");
    expect(err.message).toMatch(/parent issue not found: UE-404/);
    expect(err.hint).toMatch(/UE-404/);
  });
});
