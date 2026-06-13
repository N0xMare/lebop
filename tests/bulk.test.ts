import { beforeEach, describe, expect, it, vi } from "vitest";

import { RateLimitError } from "../src/lib/errors.ts";

// Mock entries are EITHER a successful response `{ data }` OR a thrown error
// `{ _throw: Error }`. The latter lets tests simulate boundary-mapped failures
// (RateLimitError, AuthError, etc.) on specific calls.
type MockEntry = { data: unknown } | { _throw: Error };
let mockRawResponses: MockEntry[] = [];
let calls: Array<{ query: string; variables: unknown }> = [];

function consumeMock(query: string): { data: unknown } {
  const next = mockRawResponses.shift();
  if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}`);
  if ("_throw" in next) throw next._throw;
  return next;
}

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          calls.push({ query, variables });
          return consumeMock(query);
        },
      },
      // Round-8 / R7-L2: viewer is resolved at the SDK boundary for `@me`/
      // `me` assignee tokens — provide a stub so tests that exercise
      // string-assignee paths don't crash on a missing field.
      get viewer() {
        return Promise.resolve({ id: "viewer-uuid", email: "test@example.com" });
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: async (query: string, variables: unknown) => {
        calls.push({ query, variables });
        return consumeMock(query);
      },
    },
  }),
}));

// Avoid hitting the on-disk team-metadata cache by stubbing resolve.ts. Bulk
// only needs the four primitive resolvers; everything else is plain values.
vi.mock("../src/lib/resolve.ts", async (orig) => {
  const original = (await orig()) as typeof import("../src/lib/resolve.ts");
  return {
    ...original,
    getTeamMetadata: async () => ({
      team_id: "team-uuid-nox",
      team_key: "NOX",
      fetched_at: new Date().toISOString(),
      states: [{ id: "state-done", name: "Done", type: "completed" }],
      labels: [],
      members: [],
      projects: [],
    }),
    withFreshMetadataOnMiss: async <T>(
      _fetch: unknown,
      use: (md: unknown) => Promise<T>,
    ): Promise<T> =>
      use({
        team_id: "team-uuid-nox",
        team_key: "NOX",
        fetched_at: new Date().toISOString(),
        states: [{ id: "state-done", name: "Done", type: "completed" }],
        labels: [],
        members: [],
        projects: [],
      }),
  };
});

import { bulkUpdateIssues } from "../src/lib/bulk.ts";

beforeEach(() => {
  mockRawResponses = [];
  calls = [];
});

describe("bulkUpdateIssues", () => {
  it("partial success: one good id + one not-found surfaces both rows", async () => {
    // Step 1: resolve NOX-34 → uuid (parallel issue(id) lookups).
    mockRawResponses.push({
      data: { issue: { id: "issue-uuid-34", identifier: "NOX-34" } },
    });
    // Step 2: resolve NOX-999 → null.
    mockRawResponses.push({ data: { issue: null } });
    // Step 3: issueBatchUpdate
    mockRawResponses.push({
      data: {
        issueBatchUpdate: {
          success: true,
          issues: [{ id: "issue-uuid-34", identifier: "NOX-34" }],
        },
      },
    });

    const result = await bulkUpdateIssues({
      identifiers: ["NOX-34", "NOX-999"],
      patch: { state: "Done" },
    });

    expect(result.summary).toMatchObject({ updated: 1, would_update: 0, failed: 1, total: 2 });
    const updated = result.results.find((r) => r.identifier === "NOX-34");
    const failed = result.results.find((r) => r.identifier === "NOX-999");
    expect(updated?.status).toBe("updated");
    expect(updated?.fields).toContain("state");
    expect(failed?.status).toBe("failed");
    expect(failed?.error?.code).toBe("not_found");
  });

  it("rejects empty patch with a validation_error", async () => {
    const err = await bulkUpdateIssues({
      identifiers: ["NOX-1"],
      patch: {},
    }).catch((e) => e);
    expect(err?.code).toBe("validation_error");
  });

  it("preserves real error code per row when resolution throws non-NotFound (rate_limit)", async () => {
    // Single identifier whose resolution call throws a boundary-mapped
    // RateLimitError. Step 3 (issueBatchUpdate) is skipped because no IDs
    // resolved — the result is purely the per-row error from step 2.
    mockRawResponses.push({
      _throw: new RateLimitError(
        "rate limited by Linear",
        "back off and retry, or raise LEBOP_MAX_ITEMS if this is a long scan",
      ),
    });

    const result = await bulkUpdateIssues({
      identifiers: ["NOX-35"],
      patch: { priority: 2 },
    });

    expect(result.summary).toMatchObject({ updated: 0, would_update: 0, failed: 1, total: 1 });
    const failed = result.results[0];
    expect(failed?.identifier).toBe("NOX-35");
    expect(failed?.status).toBe("failed");
    // Critical regression guard: the row's error code reflects the REAL
    // failure (rate_limit_error), not the silent `not_found` the pre-fix
    // bare-catch used to produce. Hint is preserved.
    expect(failed?.error?.code).toBe("rate_limit_error");
    expect(failed?.error?.hint).toContain("back off");
  });

  it("empty identifiers returns an empty summary without firing the batch", async () => {
    const result = await bulkUpdateIssues({
      identifiers: [],
      patch: { state: "Done" },
    });
    expect(result.summary.total).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("dry-run resolves target rows without calling issueBatchUpdate", async () => {
    mockRawResponses.push({
      data: { issue: { id: "issue-uuid-50", identifier: "NOX-50" } },
    });

    const result = await bulkUpdateIssues({
      identifiers: ["NOX-50"],
      patch: { priority: 2 },
      dryRun: true,
    });

    expect(result.summary).toMatchObject({
      updated: 0,
      would_update: 1,
      failed: 0,
      total: 1,
      dry_run: true,
    });
    expect(result.results).toEqual([
      expect.objectContaining({
        identifier: "NOX-50",
        status: "would_update",
        fields: ["priority"],
      }),
    ]);
    expect(calls.some((call) => call.query.includes("issueBatchUpdate"))).toBe(false);
    expect(result.cache.rows).toEqual([]);
  });

  it("rejects malformed priority before resolving issues", async () => {
    await expect(
      bulkUpdateIssues({
        identifiers: ["NOX-50"],
        patch: { priority: "3abc" },
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    expect(calls).toHaveLength(0);
  });

  it("rejects duplicate workspace project names before resolving issues", async () => {
    mockRawResponses.push({
      data: {
        projects: {
          nodes: [
            { id: "project-nox", name: "Shared Name", teams: { nodes: [{ key: "NOX" }] } },
            { id: "project-eng", name: "Shared Name", teams: { nodes: [{ key: "ENG" }] } },
          ],
        },
      },
    });

    await expect(
      bulkUpdateIssues({
        identifiers: ["NOX-50"],
        patch: { project: "Shared Name" },
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("first: 2");
    expect(calls[0]?.variables).toEqual({ name: "Shared Name" });
  });

  it("honors explicit team scope for project-name misses", async () => {
    mockRawResponses.push({ data: { projects: { nodes: [] } } });

    await expect(
      bulkUpdateIssues({
        identifiers: ["NOX-50"],
        team: "NOX",
        patch: { project: "Other Team Project" },
      }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "project not found: Other Team Project (team NOX)",
    });

    expect(calls[0]?.query).toContain("accessibleTeams");
    expect(calls[0]?.variables).toEqual({ name: "Other Team Project", teamKey: "NOX" });
  });

  it("rejects milestone names without a target project scope before resolving issues", async () => {
    await expect(
      bulkUpdateIssues({
        identifiers: ["NOX-50"],
        patch: { milestone: "Beta" },
      }),
    ).rejects.toMatchObject({ code: "validation_error" });

    expect(calls).toHaveLength(0);
  });

  it("scopes milestone names to the target project in the same patch", async () => {
    mockRawResponses.push({
      data: { projects: { nodes: [{ id: "project-1", name: "Target", teams: { nodes: [] } }] } },
    });
    mockRawResponses.push({
      data: {
        projectMilestones: {
          nodes: [
            { id: "milestone-1", name: "Beta", project: { id: "project-1", name: "Target" } },
          ],
        },
      },
    });
    mockRawResponses.push({
      data: { issue: { id: "issue-uuid-50", identifier: "NOX-50" } },
    });
    mockRawResponses.push({
      data: {
        issueBatchUpdate: {
          success: true,
          issues: [{ id: "issue-uuid-50", identifier: "NOX-50" }],
        },
      },
    });

    const result = await bulkUpdateIssues({
      identifiers: ["NOX-50"],
      patch: { project: "Target", milestone: "Beta" },
    });

    expect(result.summary.updated).toBe(1);
    const milestoneCall = calls.find((call) => call.query.includes("projectMilestones"));
    expect(milestoneCall?.query).toContain("$projectId: ID!");
    expect(milestoneCall?.variables).toEqual({ name: "Beta", projectId: "project-1" });
    const batchCall = calls.find((call) => call.query.includes("issueBatchUpdate"));
    expect(batchCall?.variables).toMatchObject({
      input: { projectId: "project-1", projectMilestoneId: "milestone-1" },
    });
  });

  it("resolves @me via the viewer hoist when patch.assignee=@me (round-8 / R7-L2)", async () => {
    // Pre-fix: multi-team identifiers + `@me` assignee silently dropped
    // the assignee (needsTeamScope=false for @me, teamKey=null because
    // multi-team; closure never fired). The viewer hoist resolves @me via
    // the workspace-wide viewer query independent of team scope.
    // Step 1: resolve identifier → uuid
    mockRawResponses.push({
      data: { issue: { id: "issue-uuid-50", identifier: "NOX-50" } },
    });
    // Step 2: issueBatchUpdate
    mockRawResponses.push({
      data: {
        issueBatchUpdate: {
          success: true,
          issues: [{ id: "issue-uuid-50", identifier: "NOX-50" }],
        },
      },
    });

    const result = await bulkUpdateIssues({
      identifiers: ["NOX-50"],
      patch: { assignee: "@me" },
    });

    expect(result.summary.updated).toBe(1);
    expect(result.results[0]?.fields).toContain("assignee");
    // The batch mutation receives assigneeId = viewer.id (from the stubbed
    // viewer accessor). Find the batch mutation call and inspect its input.
    const batchCall = calls.find((c) => c.query.includes("issueBatchUpdate"));
    const input = (batchCall?.variables as { input: { assigneeId?: string } } | undefined)?.input;
    expect(input?.assigneeId).toBe("viewer-uuid");
  });

  it("@me works even with multi-team identifiers (no team scope required)", async () => {
    // Pre-fix this was the silent-drop case: NOX-1 + ENG-1 → deriveTeam
    // throws → derived=null → teamKey=undefined → closure skipped →
    // assigneeId never set → linearInput empty → "patch is empty" error.
    // Post-fix: viewer hoist applies regardless of team derivation.
    mockRawResponses.push({
      data: { issue: { id: "issue-uuid-nox-1", identifier: "NOX-1" } },
    });
    mockRawResponses.push({
      data: { issue: { id: "issue-uuid-eng-1", identifier: "ENG-1" } },
    });
    mockRawResponses.push({
      data: {
        issueBatchUpdate: {
          success: true,
          issues: [
            { id: "issue-uuid-nox-1", identifier: "NOX-1" },
            { id: "issue-uuid-eng-1", identifier: "ENG-1" },
          ],
        },
      },
    });

    const result = await bulkUpdateIssues({
      identifiers: ["NOX-1", "ENG-1"],
      patch: { assignee: "@me" },
    });

    expect(result.summary.updated).toBe(2);
    const batchCall = calls.find((c) => c.query.includes("issueBatchUpdate"));
    const input = (batchCall?.variables as { input: { assigneeId?: string } } | undefined)?.input;
    expect(input?.assigneeId).toBe("viewer-uuid");
  });

  it("marks all resolved rows failed when issueBatchUpdate returns success:false", async () => {
    mockRawResponses.push({
      data: { issue: { id: "issue-uuid-60", identifier: "NOX-60" } },
    });
    mockRawResponses.push({
      data: { issue: { id: "issue-uuid-61", identifier: "NOX-61" } },
    });
    mockRawResponses.push({
      data: {
        issueBatchUpdate: {
          success: false,
          issues: [
            { id: "issue-uuid-60", identifier: "NOX-60" },
            { id: "issue-uuid-61", identifier: "NOX-61" },
          ],
        },
      },
    });

    const result = await bulkUpdateIssues({
      identifiers: ["NOX-60", "NOX-61"],
      patch: { priority: 2 },
    });

    expect(result.summary).toMatchObject({ updated: 0, would_update: 0, failed: 2, total: 2 });
    expect(result.results).toEqual([
      expect.objectContaining({
        identifier: "NOX-60",
        status: "failed",
        error: expect.objectContaining({
          code: "validation_error",
          message: "issueBatchUpdate failed",
        }),
      }),
      expect.objectContaining({
        identifier: "NOX-61",
        status: "failed",
        error: expect.objectContaining({
          code: "validation_error",
          message: "issueBatchUpdate failed",
        }),
      }),
    ]);
  });
});
