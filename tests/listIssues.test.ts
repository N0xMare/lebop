import { describe, expect, it, vi } from "vitest";
import { buildIssueFilter } from "../src/lib/listIssues.ts";

// `me`/`@me` resolution does a viewer lookup via withClient. Mock it so
// the filter-building tests don't need a real Linear client.
vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: { viewer: Promise<{ id: string }> }) => Promise<T>): Promise<T> =>
    fn({ viewer: Promise.resolve({ id: "viewer-id-mock" }) }),
  linear: async () => {
    throw new Error("linear() should not be called in buildIssueFilter tests");
  },
}));

describe("buildIssueFilter", () => {
  it("returns empty filter object when no opts + no team", async () => {
    const f = await buildIssueFilter({}, undefined);
    expect(f).toEqual({});
  });

  it("scopes to team when resolvedTeam is set", async () => {
    const f = await buildIssueFilter({}, "ENG");
    expect(f.team).toEqual({ key: { eq: "ENG" } });
  });

  it("drops team filter when allTeams is true", async () => {
    const f = await buildIssueFilter({ allTeams: true }, "ENG");
    expect(f.team).toBeUndefined();
  });

  it("filters by project name", async () => {
    const f = await buildIssueFilter({ project: "Foo" }, undefined);
    expect(f.project).toEqual({ name: { eq: "Foo" } });
  });

  it("filters by project UUID (overrides name path)", async () => {
    const f = await buildIssueFilter(
      { project: "Foo", projectId: "00000000-0000-0000-0000-000000000000" },
      undefined,
    );
    expect(f.project).toEqual({ id: { eq: "00000000-0000-0000-0000-000000000000" } });
  });

  it("combines state name and state type", async () => {
    const f = await buildIssueFilter({ state: "In Progress", stateType: "started" }, undefined);
    expect(f.state).toEqual({ name: { eq: "In Progress" }, type: { eq: "started" } });
  });

  it("uses stateTypeIn for multi-state filtering (server-side)", async () => {
    const f = await buildIssueFilter(
      { stateTypeIn: ["triage", "backlog", "unstarted", "started"] },
      undefined,
    );
    expect(f.state).toEqual({ type: { in: ["triage", "backlog", "unstarted", "started"] } });
  });

  it("stateType (eq) wins over stateTypeIn when both set", async () => {
    const f = await buildIssueFilter(
      { stateType: "started", stateTypeIn: ["triage", "backlog"] },
      undefined,
    );
    expect(f.state).toEqual({ type: { eq: "started" } });
  });

  it("filters by label list (some-of)", async () => {
    const f = await buildIssueFilter({ label: ["bug", "p0"] }, undefined);
    expect(f.labels).toEqual({ some: { name: { in: ["bug", "p0"] } } });
  });

  it("ignores empty label array", async () => {
    const f = await buildIssueFilter({ label: [] }, undefined);
    expect(f.labels).toBeUndefined();
  });

  it("filters by priority", async () => {
    const f = await buildIssueFilter({ priority: 2 }, undefined);
    expect(f.priority).toEqual({ eq: 2 });
  });

  it("routes cycle by UUID vs name", async () => {
    const fByName = await buildIssueFilter({ cycle: "Q1 2026" }, undefined);
    expect(fByName.cycle).toEqual({ name: { eq: "Q1 2026" } });

    const fById = await buildIssueFilter(
      { cycle: "00000000-0000-0000-0000-000000000000" },
      undefined,
    );
    expect(fById.cycle).toEqual({ id: { eq: "00000000-0000-0000-0000-000000000000" } });
  });

  it("routes milestone by UUID vs name", async () => {
    const fByName = await buildIssueFilter({ milestone: "Beta" }, undefined);
    expect(fByName.projectMilestone).toEqual({ name: { eq: "Beta" } });

    const fById = await buildIssueFilter(
      { milestone: "00000000-0000-0000-0000-000000000000" },
      undefined,
    );
    expect(fById.projectMilestone).toEqual({
      id: { eq: "00000000-0000-0000-0000-000000000000" },
    });
  });

  describe("assignee", () => {
    it("routes 'me' to viewer.id eq", async () => {
      const f = await buildIssueFilter({ assignee: "me" }, undefined);
      expect(f.assignee).toEqual({ id: { eq: "viewer-id-mock" } });
    });

    it("routes '@me' to viewer.id eq", async () => {
      const f = await buildIssueFilter({ assignee: "@me" }, undefined);
      expect(f.assignee).toEqual({ id: { eq: "viewer-id-mock" } });
    });

    it("routes email to email eq", async () => {
      const f = await buildIssueFilter({ assignee: "alice@example.com" }, undefined);
      expect(f.assignee).toEqual({ email: { eq: "alice@example.com" } });
    });

    it("routes plain name to name eq", async () => {
      const f = await buildIssueFilter({ assignee: "Alice" }, undefined);
      expect(f.assignee).toEqual({ name: { eq: "Alice" } });
    });

    it("treats * as no-op (any assignee)", async () => {
      const f = await buildIssueFilter({ assignee: "*" }, undefined);
      expect(f.assignee).toBeUndefined();
    });

    it("unassigned filter overrides assignee absence", async () => {
      const f = await buildIssueFilter({ unassigned: true }, undefined);
      expect(f.assignee).toEqual({ null: true });
    });

    it("throws when both unassigned + assignee set", async () => {
      await expect(
        buildIssueFilter({ unassigned: true, assignee: "me" }, undefined),
      ).rejects.toThrow(/mutually exclusive/);
    });
  });

  describe("time filters", () => {
    it("parses Nd relative for updatedSince", async () => {
      const f = await buildIssueFilter({ updatedSince: "7d" }, undefined);
      const updatedAt = (f.updatedAt as { gte: Date }).gte;
      expect(updatedAt).toBeInstanceOf(Date);
      // Should be ~7 days ago, ±1s for test runtime
      const diff = Date.now() - updatedAt.getTime();
      expect(diff).toBeGreaterThan(7 * 86400_000 - 1000);
      expect(diff).toBeLessThan(7 * 86400_000 + 1000);
    });

    it("parses Nh relative for createdAfter", async () => {
      const f = await buildIssueFilter({ createdAfter: "24h" }, undefined);
      const createdAt = (f.createdAt as { gte: Date }).gte;
      const diff = Date.now() - createdAt.getTime();
      expect(diff).toBeGreaterThan(24 * 3600_000 - 1000);
      expect(diff).toBeLessThan(24 * 3600_000 + 1000);
    });

    it("parses ISO timestamp for updatedSince", async () => {
      const f = await buildIssueFilter({ updatedSince: "2026-01-01T00:00:00Z" }, undefined);
      const updatedAt = (f.updatedAt as { gte: Date }).gte;
      expect(updatedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    });

    it("throws on unparseable time format", async () => {
      await expect(buildIssueFilter({ updatedSince: "not a date" }, undefined)).rejects.toThrow(
        /unrecognised time format/,
      );
    });
  });

  it("filters by search via searchableContent", async () => {
    const f = await buildIssueFilter({ search: "rate limit" }, undefined);
    expect(f.searchableContent).toEqual({ contains: "rate limit" });
  });
});
