/**
 * Wave 3 / structured-error taxonomy: `listTeamMembers` with a team key that
 * doesn't resolve must surface a NotFoundError, not a raw Error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../src/lib/errors.ts";

const mocks = vi.hoisted(() => ({
  teams: vi.fn(),
  rawRequest: vi.fn(),
}));

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> => {
    const client = {
      teams: mocks.teams,
      client: { rawRequest: mocks.rawRequest },
    };
    try {
      return await fn(client);
    } catch (err) {
      const retryable =
        (err as { status?: number }).status === 503 ||
        (err instanceof Error && err.message.includes("503"));
      if (!retryable) throw err;
      return fn(client);
    }
  },
  linear: async () => ({
    client: { rawRequest: mocks.rawRequest },
  }),
}));

import { listTeamMembers, listTeamMembersPage } from "../src/lib/teamMembers.ts";

describe("listTeamMembers (structured errors)", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.teams.mockResolvedValue({ nodes: [{ id: "team-1", key: "NOX", name: "Noxor" }] });
    mocks.rawRequest.mockResolvedValue({
      data: {
        team: {
          memberships: {
            nodes: [],
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
  });

  it("team-not-found is a NotFoundError with code + hint", async () => {
    mocks.teams.mockResolvedValueOnce({ nodes: [] });

    const err = await listTeamMembers({ teamKey: "GHOST" }).catch((e) => e);

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ code: "not_found", hint: expect.any(String) });
    expect(err.message).toMatch(/team not found: GHOST/);
  });

  it("keeps reading active-only pages until the visible page is full", async () => {
    mocks.rawRequest
      .mockResolvedValueOnce(membershipPage([member("inactive-1", false)], true, "cursor-1"))
      .mockResolvedValueOnce(
        membershipPage([member("active-1", true), member("active-2", true)], true, "cursor-3", 2),
      );

    const page = await listTeamMembersPage({ teamKey: "NOX", limit: 2 });

    expect(page.nodes.map((m) => m.id)).toEqual(["active-1", "active-2"]);
    expect(page.pageInfo).toEqual({ hasNextPage: true, endCursor: "cursor-3" });
    expect(mocks.rawRequest).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ after: "cursor-1" }),
    );
  });

  it("retries a transient first membership page failure", async () => {
    const transient = new Error("503 service unavailable") as Error & { status: number };
    transient.status = 503;
    mocks.rawRequest
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(membershipPage([member("active-1", true)], false, null));

    const page = await listTeamMembersPage({ teamKey: "NOX", limit: 1 });

    expect(page.nodes.map((m) => m.id)).toEqual(["active-1"]);
    expect(mocks.rawRequest).toHaveBeenCalledTimes(2);
  });

  it("uses the last emitted member edge as the active-only continuation boundary", async () => {
    mocks.rawRequest.mockResolvedValueOnce(
      membershipPage(
        [member("inactive-1", false), member("active-1", true), member("active-2", true)],
        false,
        "cursor-3",
      ),
    );

    const page = await listTeamMembersPage({ teamKey: "NOX", limit: 1 });

    expect(page.nodes.map((m) => m.id)).toEqual(["active-1"]);
    expect(page.pageInfo).toEqual({ hasNextPage: true, endCursor: "cursor-2" });
  });
});

function member(id: string, active: boolean) {
  return {
    id: `membership-${id}`,
    owner: false,
    user: {
      id,
      name: id,
      email: `${id}@example.com`,
      displayName: null,
      active,
    },
  };
}

function membershipPage(
  nodes: ReturnType<typeof member>[],
  hasNextPage: boolean,
  endCursor: string | null,
  cursorStart = 1,
) {
  return {
    data: {
      team: {
        memberships: {
          nodes,
          edges: nodes.map((node, index) => ({ cursor: `cursor-${cursorStart + index}`, node })),
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  };
}
