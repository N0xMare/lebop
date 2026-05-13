import { beforeEach, describe, expect, it, vi } from "vitest";

let mockRawResponses: Array<{ data: unknown }> = [];

vi.mock("../src/lib/sdk.ts", () => ({
  linear: async () => ({
    client: {
      rawRequest: async (_q: string, _v: unknown) => {
        const next = mockRawResponses.shift();
        if (!next) throw new Error("mock exhausted");
        return next;
      },
    },
  }),
}));

import { listWorkflowStates } from "../src/lib/workflowStates.ts";

beforeEach(() => {
  mockRawResponses = [];
});

describe("listWorkflowStates", () => {
  it("returns all states with default flag set on the team's defaultIssueState", async () => {
    mockRawResponses.push({
      data: {
        teams: {
          nodes: [
            {
              id: "team-uuid-nox",
              key: "NOX",
              name: "Noxor",
              defaultIssueState: { id: "state-bl" },
              states: {
                nodes: [
                  { id: "state-bl", name: "Backlog", type: "backlog", color: "#888" },
                  { id: "state-ip", name: "In Progress", type: "started", color: "#36f" },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          ],
        },
      },
    });
    const r = await listWorkflowStates("nox");
    expect(r?.team).toBe("NOX");
    expect(r?.states).toHaveLength(2);
    expect(r?.states.find((s) => s.id === "state-bl")?.default).toBe(true);
    expect(r?.states.find((s) => s.id === "state-ip")?.default).toBe(false);
  });

  it("returns null when team is missing", async () => {
    mockRawResponses.push({ data: { teams: { nodes: [] } } });
    expect(await listWorkflowStates("GHOST")).toBeNull();
  });
});
