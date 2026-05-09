import { describe, expect, it, vi } from "vitest";

// Mock the Linear client BEFORE importing the lib functions under test.
// The two functions exercise different paths:
//   - initiativeAddProject: single rawRequest to InitiativeAddProjectMutation
//   - initiativeRemoveProject: rawRequest to find the edge UUID, then
//     rawRequest to InitiativeRemoveProjectMutation if found
let mockResponses: Array<{ data: unknown }> = [];
let calls: Array<{ query: string; variables: unknown }> = [];

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          calls.push({ query, variables });
          const next = mockResponses.shift();
          if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
          return next;
        },
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: async (query: string, variables: unknown) => {
        calls.push({ query, variables });
        const next = mockResponses.shift();
        if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
        return next;
      },
    },
  }),
}));

import { initiativeAddProject, initiativeRemoveProject } from "../src/lib/initiatives.ts";

function reset() {
  mockResponses = [];
  calls = [];
}

describe("initiativeAddProject", () => {
  it("calls initiativeToProjectCreate and returns the edge id", async () => {
    reset();
    mockResponses.push({
      data: {
        initiativeToProjectCreate: {
          success: true,
          initiativeToProject: { id: "edge-uuid-1" },
        },
      },
    });

    const result = await initiativeAddProject({
      initiativeId: "init-1",
      projectId: "proj-1",
    });

    expect(result.id).toBe("edge-uuid-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("initiativeToProjectCreate");
    expect(calls[0]?.variables).toEqual({
      input: { initiativeId: "init-1", projectId: "proj-1" },
    });
  });

  it("forwards sortOrder when provided", async () => {
    reset();
    mockResponses.push({
      data: {
        initiativeToProjectCreate: {
          success: true,
          initiativeToProject: { id: "edge-uuid-2" },
        },
      },
    });

    await initiativeAddProject({
      initiativeId: "init-2",
      projectId: "proj-2",
      sortOrder: 42,
    });

    expect(calls[0]?.variables).toEqual({
      input: { initiativeId: "init-2", projectId: "proj-2", sortOrder: 42 },
    });
  });

  it("propagates errors from the SDK (e.g. transient network failure)", async () => {
    reset();
    // Empty mock queue → the rawRequest will throw "mock exhausted: ..."
    await expect(
      initiativeAddProject({ initiativeId: "init-x", projectId: "proj-x" }),
    ).rejects.toThrow();
  });
});

describe("initiativeRemoveProject", () => {
  it("does find-then-delete when the edge exists", async () => {
    reset();
    // First call: find query returns the edge id
    mockResponses.push({
      data: {
        initiativeToProjects: {
          nodes: [{ id: "edge-uuid-3" }],
        },
      },
    });
    // Second call: delete mutation reports success
    mockResponses.push({
      data: { initiativeToProjectDelete: { success: true } },
    });

    const success = await initiativeRemoveProject({
      initiativeId: "init-3",
      projectId: "proj-3",
    });

    expect(success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain("initiativeToProjects");
    expect(calls[0]?.variables).toEqual({ initiativeId: "init-3", projectId: "proj-3" });
    expect(calls[1]?.query).toContain("initiativeToProjectDelete");
    expect(calls[1]?.variables).toEqual({ id: "edge-uuid-3" });
  });

  it("returns false (no second call) when the edge is already absent", async () => {
    reset();
    mockResponses.push({
      data: { initiativeToProjects: { nodes: [] } },
    });

    const success = await initiativeRemoveProject({
      initiativeId: "init-4",
      projectId: "proj-4",
    });

    expect(success).toBe(false);
    expect(calls).toHaveLength(1); // only the find call; no delete attempted
  });

  it("idempotent under repeated calls (find returns nothing on retry)", async () => {
    reset();
    // First invocation: edge exists, delete succeeds
    mockResponses.push({
      data: { initiativeToProjects: { nodes: [{ id: "edge-uuid-5" }] } },
    });
    mockResponses.push({
      data: { initiativeToProjectDelete: { success: true } },
    });
    // Second invocation: edge is gone now
    mockResponses.push({
      data: { initiativeToProjects: { nodes: [] } },
    });

    const first = await initiativeRemoveProject({
      initiativeId: "init-5",
      projectId: "proj-5",
    });
    const second = await initiativeRemoveProject({
      initiativeId: "init-5",
      projectId: "proj-5",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(calls).toHaveLength(3); // find+delete, then find-only
  });

  it("propagates errors from the find call (no delete attempted)", async () => {
    reset();
    // Empty mock queue → first call throws; second never happens
    await expect(
      initiativeRemoveProject({ initiativeId: "init-x", projectId: "proj-x" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
