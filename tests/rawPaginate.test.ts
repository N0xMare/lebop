import { afterEach, describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import { findConnectionKey, isConnection, paginateRawQuery } from "../src/lib/rawPaginate.ts";

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Build a stub fetcher returning pre-canned response shapes per call. */
function makeFetcher(pages: Array<Record<string, unknown>>) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const fetch = async (vars: Record<string, unknown>) => {
    calls.push(vars);
    const data = pages[i++];
    if (!data) throw new Error(`fetcher exhausted at page ${i - 1}`);
    return { data };
  };
  return { fetch, calls };
}

describe("isConnection", () => {
  it("recognizes connection-shaped objects", () => {
    expect(isConnection({ nodes: [], pageInfo: {} })).toBe(true);
    expect(
      isConnection({ nodes: ["a", "b"], pageInfo: { hasNextPage: false, endCursor: null } }),
    ).toBe(true);
  });

  it("rejects shapes missing nodes or pageInfo", () => {
    expect(isConnection({ nodes: [] })).toBe(false);
    expect(isConnection({ pageInfo: {} })).toBe(false);
    expect(isConnection({ nodes: "not an array", pageInfo: {} })).toBe(false);
    expect(isConnection({ nodes: [], pageInfo: null })).toBe(false);
  });

  it("handles non-object inputs", () => {
    expect(isConnection(null)).toBe(false);
    expect(isConnection(undefined)).toBe(false);
    expect(isConnection("string")).toBe(false);
    expect(isConnection(42)).toBe(false);
  });
});

describe("findConnectionKey", () => {
  it("finds the first connection-shaped field", () => {
    expect(
      findConnectionKey({
        viewer: { id: "x" },
        issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
    ).toBe("issues");
  });

  it("returns null when no connections present", () => {
    expect(findConnectionKey({ viewer: { id: "x" }, count: 5 })).toBeNull();
    expect(findConnectionKey({})).toBeNull();
  });

  it("returns the first match when multiple connections exist", () => {
    const data = {
      issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    };
    // JS object property order: insertion order. issues comes first.
    expect(findConnectionKey(data)).toBe("issues");
  });
});

describe("paginateRawQuery", () => {
  const previousMaxItems = process.env.LEBOP_MAX_ITEMS;

  afterEach(() => {
    if (previousMaxItems === undefined) delete process.env.LEBOP_MAX_ITEMS;
    else process.env.LEBOP_MAX_ITEMS = previousMaxItems;
  });

  it("walks until hasNextPage is false and merges nodes", async () => {
    const { fetch, calls } = makeFetcher([
      { issues: { nodes: ["a", "b"], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
      { issues: { nodes: ["c", "d"], pageInfo: { hasNextPage: true, endCursor: "c2" } } },
      { issues: { nodes: ["e"], pageInfo: { hasNextPage: false, endCursor: null } } },
    ]);
    const result = (await paginateRawQuery({}, fetch)) as {
      issues: Page<string>;
    };
    expect(result.issues.nodes).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.after).toBeUndefined();
    expect(calls[1]?.after).toBe("c1");
    expect(calls[2]?.after).toBe("c2");
  });

  it("preserves the connection key + other response fields", async () => {
    const { fetch } = makeFetcher([
      {
        viewer: { id: "v1" },
        teams: {
          nodes: ["A"],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ]);
    const result = (await paginateRawQuery({}, fetch)) as {
      viewer: { id: string };
      teams: Page<string>;
    };
    expect(result.viewer.id).toBe("v1");
    expect(result.teams.nodes).toEqual(["A"]);
  });

  it("uses initialVars.first as page size when provided", async () => {
    const { fetch, calls } = makeFetcher([
      { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    ]);
    await paginateRawQuery({ first: 10 }, fetch);
    expect(calls[0]?.first).toBe(10);
  });

  it("defaults page size to 250 when not provided", async () => {
    const { fetch, calls } = makeFetcher([
      { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    ]);
    await paginateRawQuery({}, fetch);
    expect(calls[0]?.first).toBe(250);
  });

  it("respects initial `after` cursor (resume)", async () => {
    const { fetch, calls } = makeFetcher([
      { issues: { nodes: ["x"], pageInfo: { hasNextPage: false, endCursor: null } } },
    ]);
    await paginateRawQuery({ after: "preset" }, fetch);
    expect(calls[0]?.after).toBe("preset");
  });

  it("throws when no connection-shaped field exists", async () => {
    const { fetch } = makeFetcher([{ viewer: { id: "x" }, count: 5 }]);
    await expect(paginateRawQuery({}, fetch)).rejects.toThrow(/no connection-shaped field/);
  });

  // Wave 3 / structured-error taxonomy: the no-connection guard must be a
  // ValidationError with code + hint.
  it("no-connection error is a ValidationError with code + hint", async () => {
    const { fetch } = makeFetcher([{ viewer: { id: "x" }, count: 5 }]);
    const err = await paginateRawQuery({}, fetch).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("throws on hasNextPage:true with null endCursor (non-continuable page)", async () => {
    const { fetch, calls } = makeFetcher([
      { issues: { nodes: ["a"], pageInfo: { hasNextPage: true, endCursor: null } } },
    ]);
    await expect(paginateRawQuery({}, fetch)).rejects.toThrow(/hasNextPage without endCursor/);
    expect(calls).toHaveLength(1);
  });

  it("returns single-page response unchanged when hasNextPage already false", async () => {
    const { fetch } = makeFetcher([
      {
        teams: {
          nodes: ["T1", "T2"],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ]);
    const result = (await paginateRawQuery({}, fetch)) as { teams: Page<string> };
    expect(result.teams.nodes).toEqual(["T1", "T2"]);
  });

  it("honors LEBOP_MAX_ITEMS as a hard safety cap", async () => {
    process.env.LEBOP_MAX_ITEMS = "2";
    const { fetch } = makeFetcher([
      { issues: { nodes: ["a", "b"], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
    ]);
    const err = await paginateRawQuery({}, fetch).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toContain("safety cap of 2");
  });

  it("detects repeated cursors before replaying a page forever", async () => {
    const { fetch, calls } = makeFetcher([
      { issues: { nodes: ["a"], pageInfo: { hasNextPage: true, endCursor: "same" } } },
      { issues: { nodes: ["b"], pageInfo: { hasNextPage: true, endCursor: "same" } } },
    ]);
    const err = await paginateRawQuery({}, fetch).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toContain("repeated cursor");
    expect(calls).toHaveLength(2);
  });
});
