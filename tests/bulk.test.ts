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

    expect(result.summary).toEqual({ updated: 1, failed: 1, total: 2 });
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

    expect(result.summary).toEqual({ updated: 0, failed: 1, total: 1 });
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
});
