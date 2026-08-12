import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../src/lib/errors.ts";

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      viewer: Promise.resolve({ id: "u1" }),
      client: { rawRequest: async () => ({ data: {} }) },
    }),
  linear: async () => ({
    issues: async () => ({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }),
  }),
}));

import { buildIssueFilter } from "../src/lib/listIssues.ts";

describe("list due date filters", () => {
  it("maps dueBefore/dueAfter into Linear dueDate lte/gte", async () => {
    const filter = await buildIssueFilter(
      {
        dueBefore: "2030-01-15",
        dueAfter: "2020-01-01",
      },
      "LEB",
    );
    expect(filter.dueDate).toBeDefined();
    const due = filter.dueDate as { lte?: Date; gte?: Date };
    expect(due.lte).toBeInstanceOf(Date);
    expect(due.gte).toBeInstanceOf(Date);
    expect(due.lte!.toISOString().startsWith("2030-01-15")).toBe(true);
    expect(due.gte!.toISOString().startsWith("2020-01-01")).toBe(true);
  });

  it("accepts relative Nd for due filters", async () => {
    const filter = await buildIssueFilter({ dueBefore: "7d" }, undefined);
    const due = filter.dueDate as { lte?: Date };
    expect(due.lte).toBeInstanceOf(Date);
    expect(due.lte!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
