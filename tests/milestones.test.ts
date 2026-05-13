/**
 * Tests for getMilestone — round-5 archive-resilient list-shape query.
 *
 * Mirrors the round-4 getInitiative test pattern. `projectMilestone(id:)`
 * throws "Entity not found" for archived milestones (cascade-archived from
 * parent-project archive — see spec §12.1 archive-bug matrix). The lib
 * uses `projectMilestones(filter: { id: { eq: $id } }, includeArchived:
 * true, first: 1) { nodes { ... } }` to surface them transparently.
 */

import { describe, expect, it, vi } from "vitest";

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

import { getMilestone } from "../src/lib/milestones.ts";

function reset(): void {
  mockResponses = [];
  calls = [];
}

describe("getMilestone — round-5 archive-resilient list-shape query", () => {
  // Round-10 / M-7-smoke: getMilestone pre-checks UUID format and returns
  // null for non-UUID input (matching get_initiative's name-resolution
  // fallthrough behavior). Tests now use UUID-shape fixture IDs.
  const M1_UUID = "11111111-1111-1111-1111-111111111111";
  const M_ARCHIVED_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const M_MISSING_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const PROJ_UUID = "22222222-2222-2222-2222-222222222222";

  it("parses the list-shape response and returns the shaped record (live milestone)", async () => {
    reset();
    mockResponses.push({
      data: {
        projectMilestones: {
          nodes: [
            {
              id: M1_UUID,
              name: "M1 — provider abstraction",
              description: "first checkpoint",
              targetDate: "2026-06-30",
              sortOrder: 53,
              archivedAt: null,
              project: { id: PROJ_UUID, name: "Email rewrite" },
            },
          ],
        },
      },
    });
    const out = await getMilestone(M1_UUID);
    expect(out).toEqual({
      id: M1_UUID,
      name: "M1 — provider abstraction",
      description: "first checkpoint",
      target_date: "2026-06-30",
      sort_order: 53,
      archived_at: null,
      project: { id: PROJ_UUID, name: "Email rewrite" },
    });
    // Critical assertion: query uses the new list-shape pattern, not the
    // single-record `projectMilestone(id:)` getter that hides archived rows.
    expect(calls[0]?.query).toContain("projectMilestones(filter:");
    expect(calls[0]?.query).toContain("includeArchived: true");
    expect(calls[0]?.query).toContain("first: 1");
    // Variable type is ID! (not String!) per Linear's schema.
    expect(calls[0]?.query).toContain("$id: ID!");
    // Round-5 follow-up: query must select archivedAt so callers can
    // distinguish live vs. cascade-archived milestones.
    expect(calls[0]?.query).toContain("archivedAt");
  });

  it("surfaces cascade-archived milestones (the bug round-5 closed)", async () => {
    reset();
    // Linear DOES return archived milestones via the list-shape query when
    // includeArchived:true is passed. Cascade-archive (parent project
    // archived) is the only path that produces an archived milestone since
    // lebop's `delete_milestone` hard-deletes. This test locks in the
    // unhiding behavior — without it, the previous single-record getter
    // would throw and getMilestone would return null silently.
    mockResponses.push({
      data: {
        projectMilestones: {
          nodes: [
            {
              id: M_ARCHIVED_UUID,
              name: "Archived milestone",
              description: null,
              targetDate: null,
              sortOrder: 100,
              archivedAt: "2026-04-15T12:00:00Z",
              project: { id: PROJ_UUID, name: "Old project" },
            },
          ],
        },
      },
    });
    const out = await getMilestone(M_ARCHIVED_UUID);
    expect(out).not.toBeNull();
    expect(out?.id).toBe(M_ARCHIVED_UUID);
    // Round-5 follow-up: archived_at must be surfaced so callers can
    // distinguish live vs. cascade-archived milestones.
    expect(out?.archived_at).toBe("2026-04-15T12:00:00Z");
  });

  it("returns null when nodes is empty (genuinely missing milestone)", async () => {
    reset();
    mockResponses.push({ data: { projectMilestones: { nodes: [] } } });
    expect(await getMilestone(M_MISSING_UUID)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("short-circuits to null without hitting Linear for non-UUID input (round-10 / M-7-smoke)", async () => {
    // Pre-fix, getMilestone with "definitely-not-a-uuid" hit Linear's `ID!`
    // scalar and surfaced as `validation_error`. Post-fix the UUID-format
    // pre-check returns null at the lib boundary — no GraphQL call.
    reset();
    expect(await getMilestone("definitely-not-a-uuid")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when SDK throws Entity not found (defensive catch path)", async () => {
    reset();
    // The list-shape query shouldn't throw NotFound under normal use (it
    // returns empty nodes for unknown ids), but the catch + null contract
    // is preserved for paranoia / unmapped SDK error shapes.
    mockResponses.push(
      Object.assign(new Error("Entity not found: ProjectMilestone"), { status: 400 }),
    );
    expect(await getMilestone("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
