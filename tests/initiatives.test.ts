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
  // Linear removed `Query.initiativeToProjects(filter:)` in 2026, so the
  // lib walks `Project.initiativeToProjects` and matches the initiative id
  // client-side. Tests mirror that two-step shape.
  function projectLinksPage(
    nodes: { id: string; initiativeId: string }[],
    hasNextPage = false,
    endCursor: string | null = null,
  ) {
    return {
      data: {
        project: {
          initiativeToProjects: {
            nodes: nodes.map((n) => ({ id: n.id, initiative: { id: n.initiativeId } })),
            pageInfo: { hasNextPage, endCursor },
          },
        },
      },
    };
  }

  it("does find-then-delete when the edge exists", async () => {
    reset();
    mockResponses.push(projectLinksPage([{ id: "edge-uuid-3", initiativeId: "init-3" }]));
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
    expect(calls[0]?.variables).toEqual({ projectId: "proj-3", first: 250, after: null });
    expect(calls[1]?.query).toContain("initiativeToProjectDelete");
    expect(calls[1]?.variables).toEqual({ id: "edge-uuid-3" });
  });

  it("returns false (no second call) when the edge is already absent", async () => {
    reset();
    mockResponses.push(projectLinksPage([]));

    const success = await initiativeRemoveProject({
      initiativeId: "init-4",
      projectId: "proj-4",
    });

    expect(success).toBe(false);
    expect(calls).toHaveLength(1); // only the find call; no delete attempted
  });

  it("idempotent under repeated calls (find returns nothing on retry)", async () => {
    reset();
    mockResponses.push(projectLinksPage([{ id: "edge-uuid-5", initiativeId: "init-5" }]));
    mockResponses.push({
      data: { initiativeToProjectDelete: { success: true } },
    });
    mockResponses.push(projectLinksPage([]));

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

  it("paginates when the project links span multiple pages", async () => {
    reset();
    // Page 1 has links to other initiatives; page 2 has the match.
    mockResponses.push(
      projectLinksPage(
        [
          { id: "edge-other-1", initiativeId: "init-other-1" },
          { id: "edge-other-2", initiativeId: "init-other-2" },
        ],
        true,
        "cursor-1",
      ),
    );
    mockResponses.push(projectLinksPage([{ id: "edge-match", initiativeId: "init-target" }]));
    mockResponses.push({
      data: { initiativeToProjectDelete: { success: true } },
    });

    const success = await initiativeRemoveProject({
      initiativeId: "init-target",
      projectId: "proj-paginated",
    });

    expect(success).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.variables).toEqual({
      projectId: "proj-paginated",
      first: 250,
      after: "cursor-1",
    });
    expect(calls[2]?.variables).toEqual({ id: "edge-match" });
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
