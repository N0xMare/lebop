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

import { lookupStateByName, lookupUserByEmail } from "../src/lib/lookups.ts";

beforeEach(() => {
  mockRawResponses = [];
  calls = [];
});

describe("lookupStateByName", () => {
  it("returns the first state node and uppercases the team key", async () => {
    mockRawResponses.push({
      data: {
        workflowStates: {
          nodes: [{ id: "state-1", name: "In Progress", type: "started" }],
        },
      },
    });
    const s = await lookupStateByName("nox", "In Progress");
    expect(s?.id).toBe("state-1");
    expect((calls[0]?.variables as { teamKey: string }).teamKey).toBe("NOX");
  });

  it("returns null when no state matches", async () => {
    mockRawResponses.push({ data: { workflowStates: { nodes: [] } } });
    const s = await lookupStateByName("NOX", "Bogus");
    expect(s).toBeNull();
  });
});

describe("lookupUserByEmail", () => {
  it("shapes the user node (displayName → display_name)", async () => {
    mockRawResponses.push({
      data: {
        users: {
          nodes: [
            {
              id: "u-1",
              email: "a@x.io",
              name: "Alice",
              displayName: "alice",
              active: true,
            },
          ],
        },
      },
    });
    const u = await lookupUserByEmail("a@x.io");
    expect(u?.display_name).toBe("alice");
    expect(u?.active).toBe(true);
  });

  it("returns null when the email is unknown", async () => {
    mockRawResponses.push({ data: { users: { nodes: [] } } });
    expect(await lookupUserByEmail("nobody@x.io")).toBeNull();
  });
});
