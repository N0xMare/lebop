/**
 * Wave 3 / structured-error taxonomy: `buildPullIssuesQuery` invariants
 * (empty identifier list, malformed TEAM-NN id) must surface as
 * ValidationError with code + hint, not raw Error.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import { buildPullIssuesQuery, hydrateIssuesBatched } from "../src/lib/pullQuery.ts";

describe("buildPullIssuesQuery (structured errors)", () => {
  it("empty identifiers is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        buildPullIssuesQuery([], false);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("malformed identifier is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        buildPullIssuesQuery(["not-an-id"], false);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("happy path still builds a query string with one alias per id", () => {
    const q = buildPullIssuesQuery(["UE-1", "a1-2"], false);
    expect(q).toContain('a0: issue(id: "UE-1")');
    expect(q).toContain('a1: issue(id: "A1-2")');
  });
});

describe("hydrateIssuesBatched", () => {
  it("splits large issue hydration into bounded alias batches", async () => {
    const calls: string[][] = [];
    const result = await hydrateIssuesBatched(
      async (query) => {
        const ids = issueIdsInQuery(query);
        calls.push(ids);
        return {
          data: Object.fromEntries(ids.map((id, index) => [`a${index}`, issue(id)])),
        };
      },
      ["UE-1", "UE-2", "UE-3"],
      { withComments: false, batchSize: 2, batchConcurrency: 1 },
    );

    expect(calls).toEqual([["UE-1", "UE-2"], ["UE-3"]]);
    expect(result.fetched.map((i) => i.identifier)).toEqual(["UE-1", "UE-2", "UE-3"]);
    expect(result.errors).toEqual([]);
    expect(result.metadata).toMatchObject({
      requested_count: 3,
      fetched_count: 3,
      failed_count: 0,
      batch_size: 2,
      batch_count: 2,
    });
  });

  it("falls back per issue when a mixed alias batch fails", async () => {
    const calls: string[][] = [];
    const result = await hydrateIssuesBatched(
      async (query) => {
        const ids = issueIdsInQuery(query);
        calls.push(ids);
        if (ids.length > 1) throw new Error("Entity not found");
        if (ids[0] === "UE-2") throw new Error("Entity not found");
        return { data: { a0: issue(ids[0] ?? "UE-0") } };
      },
      ["UE-1", "UE-2", "UE-3"],
      { withComments: false, batchSize: 3, batchConcurrency: 1, fallbackConcurrency: 1 },
    );

    expect(calls).toEqual([["UE-1", "UE-2", "UE-3"], ["UE-1"], ["UE-2"], ["UE-3"]]);
    expect(result.fetched.map((i) => i.identifier)).toEqual(["UE-1", "UE-3"]);
    expect(result.errors).toEqual([{ identifier: "UE-2", error: "not found: UE-2" }]);
    expect(result.metadata).toMatchObject({
      requested_count: 3,
      fetched_count: 2,
      failed_count: 1,
      batch_count: 1,
    });
  });

  it("rejects incomplete inline comment pagination instead of reporting completion", async () => {
    await expect(
      hydrateIssuesBatched(
        async (query) => {
          const id = issueIdsInQuery(query)[0] ?? "UE-0";
          return {
            data: {
              a0: {
                ...issue(id),
                comments: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: null },
                },
              },
            },
          };
        },
        ["UE-1"],
        { withComments: true, batchSize: 1, batchConcurrency: 1 },
      ),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "comments for UE-1 cannot continue",
    });
  });
});

function issueIdsInQuery(query: string): string[] {
  return Array.from(query.matchAll(/issue\(id: "([^"]+)"/g), (match) => match[1] ?? "");
}

function issue(identifier: string) {
  return {
    id: `${identifier.toLowerCase()}-uuid`,
    identifier,
    title: identifier,
    description: "",
    priority: 0,
    estimate: null,
    url: `https://linear.app/test/issue/${identifier}`,
    updatedAt: "2026-06-06T00:00:00.000Z",
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    assignee: null,
    project: null,
    team: { id: "team-ue", key: "UE" },
    parent: null,
    labels: { nodes: [] },
  };
}
