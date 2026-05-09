import { describe, expect, it } from "vitest";
import { paginateConnection, paginateRaw } from "../src/lib/paginate.ts";

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Build a stub fetcher that returns pre-canned pages indexed by `after` cursor.
 * Records every call so tests can assert on cursor handoff.
 */
function stubFetcher<T>(pages: Page<T>[]) {
  const calls: { first: number; after: string | undefined }[] = [];
  let pageIdx = 0;
  const fetch = async (args: { first: number; after?: string }): Promise<Page<T>> => {
    calls.push({ first: args.first, after: args.after });
    const page = pages[pageIdx];
    if (!page) throw new Error(`fetcher exhausted at page ${pageIdx}`);
    pageIdx++;
    return page;
  };
  return { fetch, calls };
}

describe("paginateConnection", () => {
  it("returns empty array on first page with no nodes and no next page", async () => {
    const { fetch, calls } = stubFetcher([
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    const result = await paginateConnection(fetch);
    expect(result).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.after).toBeUndefined();
  });

  it("walks until hasNextPage is false", async () => {
    const { fetch, calls } = stubFetcher([
      { nodes: ["a", "b"], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { nodes: ["c", "d"], pageInfo: { hasNextPage: true, endCursor: "c2" } },
      { nodes: ["e"], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    const result = await paginateConnection(fetch);
    expect(result).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.after).toBeUndefined();
    expect(calls[1]?.after).toBe("c1");
    expect(calls[2]?.after).toBe("c2");
  });

  it("respects `max` cap; clamps `first` to remaining items per page", async () => {
    const { fetch, calls } = stubFetcher([
      { nodes: ["a", "b", "c"], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { nodes: ["d", "e"], pageInfo: { hasNextPage: true, endCursor: "c2" } },
    ]);
    const result = await paginateConnection(fetch, { max: 4, pageSize: 3 });
    expect(result).toEqual(["a", "b", "c", "d"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.first).toBe(3); // pageSize, with remaining=4
    expect(calls[1]?.first).toBe(1); // remaining = 4 - 3 = 1
  });

  it("never exceeds `max` even if a page returns extra nodes", async () => {
    // Defensive against hypothetical APIs that ignore `first`.
    const { fetch } = stubFetcher([
      { nodes: ["a", "b", "c", "d", "e"], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    const result = await paginateConnection(fetch, { max: 3 });
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("starts from `initialAfter` when provided", async () => {
    const { fetch, calls } = stubFetcher([
      { nodes: ["c", "d"], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    const result = await paginateConnection(fetch, { initialAfter: "preset-cursor" });
    expect(result).toEqual(["c", "d"]);
    expect(calls[0]?.after).toBe("preset-cursor");
  });

  it("stops on hasNextPage:true but null endCursor (defensive)", async () => {
    const { fetch, calls } = stubFetcher([
      { nodes: ["a"], pageInfo: { hasNextPage: true, endCursor: null } },
    ]);
    const result = await paginateConnection(fetch);
    expect(result).toEqual(["a"]);
    expect(calls).toHaveLength(1);
  });

  it("default pageSize is 250", async () => {
    const { fetch, calls } = stubFetcher([
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    await paginateConnection(fetch);
    expect(calls[0]?.first).toBe(250);
  });
});

describe("paginateRaw", () => {
  // paginateRaw wraps a different shape: the fetcher returns the full response,
  // and a `pickConnection` extracts the {nodes, pageInfo} from inside it.
  interface Wrapped<T> {
    data: { issues: Page<T> | null };
  }

  function wrappedStub<T>(pages: Page<T>[]) {
    const calls: { first: number; after: string | undefined }[] = [];
    let i = 0;
    const fetch = async (args: { first: number; after?: string }): Promise<Wrapped<T>> => {
      calls.push({ first: args.first, after: args.after });
      const p = pages[i++];
      if (!p) throw new Error("exhausted");
      return { data: { issues: p } };
    };
    return { fetch, calls };
  }

  it("walks via pickConnection until done", async () => {
    const { fetch } = wrappedStub<string>([
      { nodes: ["a"], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { nodes: ["b"], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    const result = await paginateRaw(fetch, (r) => r.data.issues);
    expect(result).toEqual(["a", "b"]);
  });

  it("stops when pickConnection returns null", async () => {
    const fetch = async (_: { first: number; after?: string }) => ({ data: { issues: null } });
    const result = await paginateRaw(fetch, (r) => r.data.issues);
    expect(result).toEqual([]);
  });

  it("respects initialAfter for resume", async () => {
    const { fetch, calls } = wrappedStub<string>([
      { nodes: ["x"], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    await paginateRaw(fetch, (r) => r.data.issues, { initialAfter: "from-here" });
    expect(calls[0]?.after).toBe("from-here");
  });
});
