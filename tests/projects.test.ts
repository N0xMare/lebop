/**
 * Wave 3 / structured-error taxonomy: `listProjects` with a team filter that
 * doesn't resolve must surface a NotFoundError, not a raw Error. Mocks the
 * SDK so `teams(filter: { key })` returns an empty nodes array.
 */

import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../src/lib/errors.ts";

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      // Always return empty nodes — exercises the "team not found" branch.
      teams: async () => ({ nodes: [] }),
      client: { rawRequest: async () => ({ data: {} }) },
    }),
  linear: async () => ({
    client: { rawRequest: async () => ({ data: {} }) },
  }),
}));

import { listProjects } from "../src/lib/projects.ts";

describe("listProjects (structured errors)", () => {
  it("team-not-found is a NotFoundError with code + hint", async () => {
    const err = await listProjects({ team: "NONEXISTENT" }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ code: "not_found", hint: expect.any(String) });
    expect(err.message).toMatch(/team not found: NONEXISTENT/);
  });
});
