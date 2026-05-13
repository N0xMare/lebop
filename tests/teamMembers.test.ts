/**
 * Wave 3 / structured-error taxonomy: `listTeamMembers` with a team key that
 * doesn't resolve must surface a NotFoundError, not a raw Error.
 */

import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../src/lib/errors.ts";

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      teams: async () => ({ nodes: [] }),
      client: { rawRequest: async () => ({ data: {} }) },
    }),
  linear: async () => ({
    client: { rawRequest: async () => ({ data: { team: null } }) },
  }),
}));

import { listTeamMembers } from "../src/lib/teamMembers.ts";

describe("listTeamMembers (structured errors)", () => {
  it("team-not-found is a NotFoundError with code + hint", async () => {
    const err = await listTeamMembers({ teamKey: "GHOST" }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ code: "not_found", hint: expect.any(String) });
    expect(err.message).toMatch(/team not found: GHOST/);
  });
});
