import { describe, expect, it, vi } from "vitest";

let mockResponses: Array<{ data: unknown }> = [];
let calls: Array<{ query: string; variables: unknown }> = [];
let issueLookups: Array<string> = [];
const stubIssue = (identifier: string) => ({ id: `uuid-of-${identifier}` });

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      issue: async (id: string) => {
        issueLookups.push(id);
        return stubIssue(id);
      },
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

// Stub team-metadata helpers — createIssue / updateIssue route through them
// only when team / state / labels / assignee are set.
vi.mock("../src/lib/resolve.ts", () => ({
  ResolveError: class ResolveError extends Error {},
  withFreshMetadataOnMiss: async <T>(
    _fetcher: unknown,
    fn: (md: unknown) => Promise<T>,
  ): Promise<T> => fn({ team_id: "team-uuid", projects: [], states: [], labels: [], members: [] }),
  getTeamMetadata: async () => ({ team_id: "team-uuid" }),
  resolveStateId: () => "state-uuid",
  resolveLabelIds: () => ["label-uuid"],
  resolveAssigneeId: async () => "assignee-uuid",
  resolvePriority: (v: unknown) => (typeof v === "number" ? v : 2),
}));

import { archiveIssues, createIssue, unarchiveIssues, updateIssue } from "../src/lib/issues.ts";

function reset() {
  mockResponses = [];
  calls = [];
  issueLookups = [];
}

describe("createIssue", () => {
  it("builds Linear input from user-facing strings", async () => {
    reset();
    mockResponses.push({
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "issue-uuid",
            identifier: "NOX-1",
            url: "https://linear.app/x/nox-1",
            title: "T",
            state: { name: "Backlog" },
            project: null,
          },
        },
      },
    });

    const issue = await createIssue({
      team: "NOX",
      title: "T",
      description: "d",
      state: "Backlog",
      priority: "high",
      labels: ["bug"],
      assignee: "@me",
    });

    expect(issue.identifier).toBe("NOX-1");
    expect(calls[0]?.query).toContain("issueCreate");
    expect(calls[0]?.variables).toMatchObject({
      input: {
        teamId: "team-uuid",
        title: "T",
        description: "d",
        stateId: "state-uuid",
        priority: 2,
        labelIds: ["label-uuid"],
        assigneeId: "assignee-uuid",
      },
    });
  });

  it("omits resolved fields when the user didn't provide them", async () => {
    reset();
    mockResponses.push({
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "i",
            identifier: "NOX-2",
            url: "u",
            title: "T",
            state: { name: "B" },
            project: null,
          },
        },
      },
    });

    await createIssue({ team: "NOX", title: "T" });
    const input = (calls[0]?.variables as { input: Record<string, unknown> }).input;
    expect(input).toEqual({ teamId: "team-uuid", title: "T" });
  });
});

describe("updateIssue", () => {
  it("requires at least one field", async () => {
    reset();
    await expect(updateIssue({ identifier: "NOX-1" })).rejects.toThrow(/nothing to update/);
  });

  it("resolves the identifier → UUID before the mutation", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-of-NOX-1",
            identifier: "NOX-1",
            url: "u",
            title: "new title",
            state: { name: "B" },
          },
        },
      },
    });
    await updateIssue({ identifier: "NOX-1", title: "new title" });
    expect(issueLookups[0]).toBe("NOX-1");
    expect(calls[0]?.variables).toMatchObject({
      id: "uuid-of-NOX-1",
      input: { title: "new title" },
    });
  });

  it("clears parent when null is passed (vs omitted)", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    await updateIssue({ identifier: "NOX-1", team: "NOX", parent: null });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.parentId).toBeNull();
  });
});

describe("archiveIssues + unarchiveIssues", () => {
  it("archive: returns one result per identifier", async () => {
    reset();
    mockResponses.push({ data: { issueArchive: { success: true } } });
    mockResponses.push({ data: { issueArchive: { success: true } } });
    const results = await archiveIssues(["NOX-1", "NOX-2"]);
    expect(results).toEqual([
      { identifier: "NOX-1", status: "ok" },
      { identifier: "NOX-2", status: "ok" },
    ]);
  });

  it("unarchive: same shape", async () => {
    reset();
    mockResponses.push({ data: { issueUnarchive: { success: true } } });
    const results = await unarchiveIssues(["NOX-1"]);
    expect(results).toEqual([{ identifier: "NOX-1", status: "ok" }]);
  });
});
