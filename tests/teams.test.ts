import { beforeEach, describe, expect, it, vi } from "vitest";

let mockRawResponses: Array<{ data: unknown }> = [];
let calls: Array<{ query: string; variables: unknown }> = [];

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          calls.push({ query, variables });
          const next = mockRawResponses.shift();
          if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
          return next;
        },
      },
    }),
}));

import { getTeam } from "../src/lib/teams.ts";

beforeEach(() => {
  mockRawResponses = [];
  calls = [];
});

describe("getTeam", () => {
  it("resolves by KEY via teams(filter) and shapes default_state_* fields", async () => {
    mockRawResponses.push({
      data: {
        teams: {
          nodes: [
            {
              id: "team-uuid-nox",
              key: "NOX",
              name: "Noxor",
              description: "the team",
              defaultIssueState: { id: "state-bl", name: "Backlog" },
            },
          ],
        },
      },
    });
    const team = await getTeam("NOX");
    expect(team?.id).toBe("team-uuid-nox");
    expect(team?.default_state_id).toBe("state-bl");
    expect(team?.default_state_name).toBe("Backlog");
    expect((calls[0]?.variables as { key: string }).key).toBe("NOX");
  });

  it("resolves by UUID via team(id: $id)", async () => {
    mockRawResponses.push({
      data: {
        team: {
          id: "team-uuid-nox",
          key: "NOX",
          name: "Noxor",
          description: null,
          defaultIssueState: null,
        },
      },
    });
    const team = await getTeam("11111111-2222-3333-4444-555555555555");
    expect(team?.key).toBe("NOX");
    expect(team?.default_state_id).toBeNull();
  });

  it("returns null when no team matches the key", async () => {
    mockRawResponses.push({ data: { teams: { nodes: [] } } });
    const team = await getTeam("GHOST");
    expect(team).toBeNull();
  });
});
