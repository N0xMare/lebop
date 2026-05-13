import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import {
  _resetPaginateWarningState,
  paginateConnection,
  paginateRaw,
  resolveSafetyCap,
} from "../src/lib/paginate.ts";

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

describe("LEBOP_MAX_ITEMS safety cap (wave-3 round-3)", () => {
  // Each test sets LEBOP_MAX_ITEMS to a small number so we can drive the
  // walk to the cap with just a few pages. We restore the env + the
  // module-local warning latch between cases so tests stay isolated.
  let prev: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prev = process.env.LEBOP_MAX_ITEMS;
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    _resetPaginateWarningState();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LEBOP_MAX_ITEMS;
    else process.env.LEBOP_MAX_ITEMS = prev;
    stderrSpy.mockRestore();
  });

  describe("resolveSafetyCap", () => {
    it("returns 10_000 when LEBOP_MAX_ITEMS is unset", () => {
      delete process.env.LEBOP_MAX_ITEMS;
      expect(resolveSafetyCap()).toBe(10_000);
    });

    it("parses a valid integer from the env", () => {
      process.env.LEBOP_MAX_ITEMS = "42";
      expect(resolveSafetyCap()).toBe(42);
    });

    it("falls back to default for non-numeric / non-positive values", () => {
      process.env.LEBOP_MAX_ITEMS = "not a number";
      expect(resolveSafetyCap()).toBe(10_000);
      process.env.LEBOP_MAX_ITEMS = "0";
      expect(resolveSafetyCap()).toBe(10_000);
      process.env.LEBOP_MAX_ITEMS = "-5";
      expect(resolveSafetyCap()).toBe(10_000);
    });
  });

  it("emits a one-shot stderr warning when accumulated >= 50% of the cap", async () => {
    // Cap of 10 → warn fires at 5 accumulated items.
    process.env.LEBOP_MAX_ITEMS = "10";
    const { fetch } = stubFetcher([
      { nodes: ["a", "b", "c", "d", "e"], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { nodes: ["f", "g"], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    const result = await paginateConnection(fetch, { pageSize: 5 });
    expect(result).toEqual(["a", "b", "c", "d", "e", "f", "g"]);

    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    const warning = calls.find((s: string) => s.includes("approaching the safety cap"));
    expect(warning).toBeDefined();
    expect(warning).toContain("LEBOP_MAX_ITEMS");
    expect(warning).toContain("10");
  });

  it("does NOT warn when caller passes an explicit `max` (opt-in tightening)", async () => {
    // Even with a tiny env cap, an explicit max should suppress the
    // threshold warning — caller is bounding intentionally.
    process.env.LEBOP_MAX_ITEMS = "10";
    const { fetch } = stubFetcher([
      { nodes: ["a", "b", "c"], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    await paginateConnection(fetch, { max: 3, pageSize: 3 });

    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((s: string) => s.includes("approaching"))).toBe(false);
  });

  it("throws ValidationError with hint when the implicit cap is hit AND server still has pages", async () => {
    process.env.LEBOP_MAX_ITEMS = "4";
    const { fetch } = stubFetcher([
      { nodes: ["a", "b", "c", "d"], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    ]);
    let caught: unknown;
    try {
      await paginateConnection(fetch, { pageSize: 4 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const err = caught as ValidationError;
    expect(err.code).toBe("validation_error");
    expect(err.message).toContain("4");
    expect(err.hint).toContain("LEBOP_MAX_ITEMS");
  });

  it("does NOT throw at the cap when hasNextPage is false (clean exhaustion)", async () => {
    // Exactly hitting the cap is fine if the server agrees the walk is done.
    process.env.LEBOP_MAX_ITEMS = "4";
    const { fetch } = stubFetcher([
      { nodes: ["a", "b", "c", "d"], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    const result = await paginateConnection(fetch, { pageSize: 4 });
    expect(result).toEqual(["a", "b", "c", "d"]);
  });

  it("paginateRaw also honors LEBOP_MAX_ITEMS for both warning and throw", async () => {
    process.env.LEBOP_MAX_ITEMS = "6";
    interface Wrapped<T> {
      data: { issues: Page<T> | null };
    }
    const pages: Page<string>[] = [
      { nodes: ["a", "b", "c", "d", "e", "f"], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    ];
    let idx = 0;
    const fetch = async (_: { first: number; after?: string }): Promise<Wrapped<string>> => {
      const p = pages[idx++];
      if (!p) throw new Error("exhausted");
      return { data: { issues: p } };
    };

    let caught: unknown;
    try {
      await paginateRaw<string, Wrapped<string>>(fetch, (r) => r.data.issues, { pageSize: 6 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((s: string) => s.includes("approaching the safety cap"))).toBe(true);
  });
});
