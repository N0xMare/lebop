import { describe, expect, it, vi } from "vitest";

// Mock the Linear client BEFORE importing the lib functions under test.
// The two functions exercise different paths:
//   - initiativeAddProject: single rawRequest to InitiativeAddProjectMutation
//   - initiativeRemoveProject: rawRequest to find the edge UUID, then
//     rawRequest to InitiativeRemoveProjectMutation if found; on a failure
//     mode, may follow up with an archived-state probe.
let mockResponses: Array<{ data: unknown } | Error> = [];
let calls: Array<{ query: string; variables: unknown }> = [];

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          calls.push({ query, variables });
          const next = mockResponses.shift();
          if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
          if (next instanceof Error) throw next;
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
        if (next instanceof Error) throw next;
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

  it("returns { removed: true } when find-then-delete succeeds", async () => {
    reset();
    mockResponses.push(projectLinksPage([{ id: "edge-uuid-3", initiativeId: "init-3" }]));
    mockResponses.push({
      data: { initiativeToProjectDelete: { success: true } },
    });

    const result = await initiativeRemoveProject({
      initiativeId: "init-3",
      projectId: "proj-3",
    });

    expect(result).toEqual({ removed: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain("initiativeToProjects");
    expect(calls[0]?.variables).toEqual({ projectId: "proj-3", first: 250, after: null });
    expect(calls[1]?.query).toContain("initiativeToProjectDelete");
    expect(calls[1]?.variables).toEqual({ id: "edge-uuid-3" });
  });

  it("returns { removed: false, reason: 'absent' } when the link doesn't exist and initiative is live", async () => {
    reset();
    // Find returns empty edges.
    mockResponses.push(projectLinksPage([]));
    // Absent-vs-archived probe runs to disambiguate; live initiative.
    mockResponses.push({
      data: { initiatives: { nodes: [{ id: "init-4", archivedAt: null }] } },
    });

    const result = await initiativeRemoveProject({
      initiativeId: "init-4",
      projectId: "proj-4",
    });

    expect(result.removed).toBe(false);
    expect(result.reason).toBe("absent");
    expect(typeof result.message).toBe("string");
    // find + probe; no delete attempted (no edge found).
    expect(calls).toHaveLength(2);
    expect(calls[1]?.query).toContain("InitiativeArchivedProbe");
  });

  it("returns { removed: false, reason: 'archived' } when the initiative is archived (probe-only path)", async () => {
    reset();
    // When an initiative is archived, Linear hides every edge from
    // `Project.initiativeToProjects` — so find returns empty even though
    // the link existed before the archive. Probe disambiguates.
    mockResponses.push(projectLinksPage([]));
    mockResponses.push({
      data: {
        initiatives: {
          nodes: [{ id: "init-archived", archivedAt: "2026-05-01T00:00:00.000Z" }],
        },
      },
    });

    const result = await initiativeRemoveProject({
      initiativeId: "init-archived",
      projectId: "proj-archived",
    });

    expect(result.removed).toBe(false);
    expect(result.reason).toBe("archived");
    expect(result.message).toMatch(/archived/i);
    // find + probe; no delete attempted.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.query).toContain("InitiativeArchivedProbe");
  });

  it("returns { removed: false, reason: 'archived' } when delete throws NotFound and probe confirms archive (race)", async () => {
    reset();
    // Find sees the edge (initiative was live at walk time).
    mockResponses.push(projectLinksPage([{ id: "edge-raced", initiativeId: "init-raced" }]));
    // Delete throws NotFound — could be concurrent delete OR initiative
    // got archived between walk and mutation.
    const notFoundErr = new Error("Entity not found: InitiativeToProject");
    mockResponses.push(notFoundErr);
    // Probe disambiguates: initiative IS archived.
    mockResponses.push({
      data: {
        initiatives: {
          nodes: [{ id: "init-raced", archivedAt: "2026-05-12T00:00:00.000Z" }],
        },
      },
    });

    const result = await initiativeRemoveProject({
      initiativeId: "init-raced",
      projectId: "proj-raced",
    });

    expect(result.removed).toBe(false);
    expect(result.reason).toBe("archived");
    expect(calls).toHaveLength(3);
    expect(calls[2]?.query).toContain("InitiativeArchivedProbe");
  });

  it("returns { removed: false, reason: 'archived' } when delete returns success:false and probe confirms archive", async () => {
    reset();
    mockResponses.push(projectLinksPage([{ id: "edge-sf", initiativeId: "init-sf" }]));
    mockResponses.push({ data: { initiativeToProjectDelete: { success: false } } });
    // Archive-state probe runs after success:false; reports archived.
    mockResponses.push({
      data: {
        initiatives: {
          nodes: [{ id: "init-sf", archivedAt: "2026-05-01T00:00:00.000Z" }],
        },
      },
    });

    const result = await initiativeRemoveProject({
      initiativeId: "init-sf",
      projectId: "proj-sf",
    });

    expect(result.removed).toBe(false);
    expect(result.reason).toBe("archived");
    expect(calls).toHaveLength(3);
    expect(calls[2]?.query).toContain("InitiativeArchivedProbe");
  });

  it("returns { removed: false, reason: 'other' } when delete returns success:false and probe says not archived", async () => {
    reset();
    mockResponses.push(projectLinksPage([{ id: "edge-other", initiativeId: "init-other" }]));
    mockResponses.push({ data: { initiativeToProjectDelete: { success: false } } });
    mockResponses.push({
      data: { initiatives: { nodes: [{ id: "init-other", archivedAt: null }] } },
    });

    const result = await initiativeRemoveProject({
      initiativeId: "init-other",
      projectId: "proj-other",
    });

    expect(result.removed).toBe(false);
    expect(result.reason).toBe("other");
    expect(result.message).toMatch(/initiativeToProjectDelete/);
    expect(calls).toHaveLength(3);
  });

  it("idempotent under repeated calls (find returns nothing on retry)", async () => {
    reset();
    // First call: find + delete.
    mockResponses.push(projectLinksPage([{ id: "edge-uuid-5", initiativeId: "init-5" }]));
    mockResponses.push({
      data: { initiativeToProjectDelete: { success: true } },
    });
    // Second call: find returns empty + probe disambiguates absent vs archived.
    mockResponses.push(projectLinksPage([]));
    mockResponses.push({
      data: { initiatives: { nodes: [{ id: "init-5", archivedAt: null }] } },
    });

    const first = await initiativeRemoveProject({
      initiativeId: "init-5",
      projectId: "proj-5",
    });
    const second = await initiativeRemoveProject({
      initiativeId: "init-5",
      projectId: "proj-5",
    });

    expect(first).toEqual({ removed: true });
    expect(second.removed).toBe(false);
    expect(second.reason).toBe("absent");
    // first: find+delete (2 calls). second: find+probe (2 calls). total 4.
    expect(calls).toHaveLength(4);
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

    const result = await initiativeRemoveProject({
      initiativeId: "init-target",
      projectId: "proj-paginated",
    });

    expect(result).toEqual({ removed: true });
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

// Positive-shape tests for the round-4 query rewrites. These functions use
// the `initiatives(filter, includeArchived: true, first: 1) { nodes }`
// pattern instead of the single-record `initiative(id:)` getter to dodge
// Linear's archive-hide behavior (see spec §12.1 archive-bug matrix). The
// tests below mock the NEW response shape; they would fail if the lib
// reverted to parsing the old `{data: {initiative: {...}}}` shape.
describe("getInitiative — round-4 archive-resilient query", () => {
  it("parses the list-shape response and returns the full record", async () => {
    reset();
    const initiativeId = "init-shape-1";
    mockResponses.push({
      data: {
        initiatives: {
          nodes: [
            {
              id: initiativeId,
              name: "List-shape test",
              description: "verifies the new query shape parses correctly",
              status: "Active",
              color: null,
              icon: null,
              url: "https://linear.app/x/initiative/list-shape-test",
              targetDate: "2026-12-31",
              archivedAt: null,
              owner: null,
              projects: { nodes: [{ id: "proj-1", name: "Proj 1", state: "started" }] },
            },
          ],
        },
      },
    });
    const { getInitiative } = await import("../src/lib/initiatives.ts");
    const out = await getInitiative(initiativeId);
    expect(out).toMatchObject({
      id: initiativeId,
      name: "List-shape test",
      archived_at: null,
      projects: [{ id: "proj-1", name: "Proj 1", state: "started" }],
    });
    // Query should use the list-shape, not the single-record getter.
    expect(calls[0]?.query).toContain("initiatives(filter:");
    expect(calls[0]?.query).toContain("includeArchived: true");
  });

  it("surfaces archived initiatives (the bug the round-4 fix closed)", async () => {
    reset();
    const archivedAt = "2026-05-01T00:00:00.000Z";
    mockResponses.push({
      data: {
        initiatives: {
          nodes: [
            {
              id: "init-archived",
              name: "Archived init",
              description: null,
              status: "Active",
              color: null,
              icon: null,
              url: "https://linear.app/x/initiative/archived",
              targetDate: null,
              archivedAt,
              owner: null,
              projects: { nodes: [] },
            },
          ],
        },
      },
    });
    const { getInitiative } = await import("../src/lib/initiatives.ts");
    const out = await getInitiative("init-archived");
    expect(out).not.toBeNull();
    expect(out?.archived_at).toBe(archivedAt);
  });

  it("returns null when nodes is empty (genuinely missing)", async () => {
    reset();
    mockResponses.push({ data: { initiatives: { nodes: [] } } });
    const { getInitiative } = await import("../src/lib/initiatives.ts");
    expect(await getInitiative("does-not-exist")).toBeNull();
  });
});

describe("listInitiativeUpdates — round-4 archive-resilient query", () => {
  it("parses the list-shape response and walks pagination", async () => {
    reset();
    // Page 1: one update + hasNextPage true.
    mockResponses.push({
      data: {
        initiatives: {
          nodes: [
            {
              initiativeUpdates: {
                nodes: [
                  {
                    id: "u-1",
                    body: "first update",
                    health: "onTrack",
                    createdAt: "2026-05-01T00:00:00.000Z",
                    user: { id: "u-uid", name: "Justice", email: "j@x.io" },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
              },
            },
          ],
        },
      },
    });
    // Page 2: one more update + hasNextPage false.
    mockResponses.push({
      data: {
        initiatives: {
          nodes: [
            {
              initiativeUpdates: {
                nodes: [
                  {
                    id: "u-2",
                    body: "second update",
                    health: null,
                    createdAt: "2026-05-02T00:00:00.000Z",
                    user: null,
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          ],
        },
      },
    });
    const { listInitiativeUpdates } = await import("../src/lib/initiatives.ts");
    const out = await listInitiativeUpdates("init-1");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "u-1",
      body: "first update",
      health: "onTrack",
      created_at: "2026-05-01T00:00:00.000Z",
    });
    expect(out[1]).toMatchObject({ id: "u-2", health: null, user: null });
    // Both pages used the list-shape query, not the single-record getter.
    expect(calls[0]?.query).toContain("initiatives(filter:");
    expect(calls[0]?.query).toContain("includeArchived: true");
  });

  it("stops cleanly when initiative is genuinely missing (nodes empty on page 1)", async () => {
    reset();
    mockResponses.push({ data: { initiatives: { nodes: [] } } });
    const { listInitiativeUpdates } = await import("../src/lib/initiatives.ts");
    const out = await listInitiativeUpdates("does-not-exist");
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
