import { describe, expect, it, vi } from "vitest";
import { NotFoundError, ValidationError } from "../src/lib/errors.ts";

// Mock the Linear client BEFORE importing the lib functions under test.
let mockRawResponses: Array<{ data: unknown }> = [];
let mockCreateCommentResult: {
  success: boolean;
  comment: { id: string; createdAt: Date | string };
} | null = null;
let calls: Array<{ query: string; variables: unknown }> = [];
let createCommentArgs: Array<unknown> = [];
let issueLookupOverride: ((id: string) => unknown) | null = null;

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      // `withClient(c => c.issue(...))` is used by addComment to resolve the
      // identifier → UUID; return a stub issue (or whatever the per-test
      // override yields).
      issue: async (id: string) => {
        if (issueLookupOverride) return issueLookupOverride(id);
        return { id: "issue-uuid-123" };
      },
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          calls.push({ query, variables });
          const next = mockRawResponses.shift();
          if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
          return next;
        },
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: async (query: string, variables: unknown) => {
        calls.push({ query, variables });
        const next = mockRawResponses.shift();
        if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
        return next;
      },
    },
    createComment: async (input: unknown) => {
      createCommentArgs.push(input);
      if (!mockCreateCommentResult) throw new Error("mock createComment not set");
      const r = mockCreateCommentResult;
      return {
        success: r.success,
        comment: Promise.resolve(r.comment),
      };
    },
  }),
}));

import { addComment, deleteComment, listComments, updateComment } from "../src/lib/comments.ts";

function reset() {
  mockRawResponses = [];
  mockCreateCommentResult = null;
  calls = [];
  createCommentArgs = [];
  issueLookupOverride = null;
}

describe("listComments", () => {
  it("paginates + shapes nodes", async () => {
    reset();
    mockRawResponses.push({
      data: {
        issue: {
          comments: {
            nodes: [
              {
                id: "c1",
                body: "first",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                user: { id: "u1", name: "Alice", email: "a@x" },
                parent: null,
              },
              {
                id: "c2",
                body: "reply",
                createdAt: "2026-01-02T00:00:00Z",
                updatedAt: "2026-01-02T00:00:00Z",
                user: null,
                parent: { id: "c1" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const comments = await listComments("nox-1");
    expect(comments).toHaveLength(2);
    expect(comments[0]?.id).toBe("c1");
    expect(comments[0]?.parent_id).toBeNull();
    expect(comments[1]?.parent_id).toBe("c1");
    // listComments calls .toUpperCase() on the identifier before the query.
    expect(calls[0]?.variables).toMatchObject({ id: "NOX-1" });
  });

  it("returns empty array when issue is missing (paginateRaw nullable)", async () => {
    reset();
    mockRawResponses.push({ data: { issue: null } });
    const comments = await listComments("NOX-X");
    expect(comments).toEqual([]);
  });
});

describe("addComment", () => {
  it("resolves identifier → UUID, then posts via createComment", async () => {
    reset();
    mockCreateCommentResult = {
      success: true,
      comment: { id: "c-new", createdAt: new Date("2026-05-10T00:00:00Z") },
    };

    const result = await addComment({ identifier: "NOX-1", body: "hello" });
    expect(result.id).toBe("c-new");
    expect(result.created_at).toBe("2026-05-10T00:00:00.000Z");
    expect(createCommentArgs[0]).toEqual({ issueId: "issue-uuid-123", body: "hello" });
  });

  it("returns A26 thicker shape (body / url / user) when the SDK echoes them (round-6 / A26)", async () => {
    // Round-6 / A26 lock-in. The lib should surface the additional fields
    // emitted by Linear's commentCreate. Pre-fix callers had to do a
    // follow-up `list_comments` to discover URL / echo the body.
    reset();
    mockCreateCommentResult = {
      success: true,
      comment: {
        id: "c-rich",
        createdAt: new Date("2026-05-11T00:00:00Z"),
        // SDK echoes body/url/user on the same response — lib reads them via
        // optional accessors. Mock the shape directly.
        body: "hello rich",
        url: "https://linear.app/test/comment/c-rich",
        user: Promise.resolve({ id: "u1", name: "Alice", email: "a@x.io" }),
      } as never,
    };
    const result = await addComment({ identifier: "NOX-1", body: "hello rich" });
    expect(result.id).toBe("c-rich");
    expect(result.body).toBe("hello rich");
    expect(result.url).toBe("https://linear.app/test/comment/c-rich");
    expect(result.user).toEqual({ id: "u1", name: "Alice", email: "a@x.io" });
  });

  it("forwards parentId for threaded replies", async () => {
    reset();
    mockCreateCommentResult = {
      success: true,
      comment: { id: "c-reply", createdAt: "2026-05-10T00:00:00Z" },
    };
    await addComment({ identifier: "NOX-1", body: "thread reply", parentId: "c-parent" });
    expect(createCommentArgs[0]).toEqual({
      issueId: "issue-uuid-123",
      body: "thread reply",
      parentId: "c-parent",
    });
  });

  it("throws ValidationError when createComment.success is false", async () => {
    // Wave 2 / B: was previously a raw `Error('Linear rejected ...')`. The
    // structured form lets the CLI / MCP surface print the hint and assign a
    // stable exit code via `code: 'validation_error'`.
    reset();
    mockCreateCommentResult = { success: false, comment: { id: "x", createdAt: "x" } };
    const err = await addComment({ identifier: "NOX-1", body: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("validation_error");
    expect(err.message).toMatch(/Linear rejected the comment on NOX-1/);
    expect(err.hint).toMatch(/archived|valid/);
  });

  it("throws NotFoundError when the issue identifier doesn't resolve", async () => {
    // The lib's `issue not found:` raw error is also part of wave 2 cleanup
    // (issues.ts had the same shape). Verify the structured form here too.
    reset();
    issueLookupOverride = () => null;
    const err = await addComment({ identifier: "NOX-GHOST", body: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("not_found");
    expect(err.message).toMatch(/issue not found: NOX-GHOST/);
  });
});

describe("updateComment", () => {
  it("calls commentUpdate with id + input.body and returns the A26-aligned shape (round-7 / H-MCP-2)", async () => {
    // Round-7 / H-MCP-2: updateComment response now includes body, url, user
    // (parity with addComment's A26 work). Pre-fix it returned only
    // `{id, updated_at}`, forcing callers to do a follow-up `list_comments`.
    reset();
    mockRawResponses.push({
      data: {
        commentUpdate: {
          success: true,
          comment: {
            id: "c1",
            body: "edited body",
            url: "https://linear.app/test/comment/c1",
            updatedAt: "2026-05-10T01:00:00Z",
            user: { id: "u1", name: "Alice", email: "a@x.io" },
          },
        },
      },
    });
    const result = await updateComment("c1", "edited body");
    expect(result).toEqual({
      id: "c1",
      updated_at: "2026-05-10T01:00:00Z",
      body: "edited body",
      url: "https://linear.app/test/comment/c1",
      user: { id: "u1", name: "Alice", email: "a@x.io" },
    });
    expect(calls[0]?.variables).toEqual({ id: "c1", input: { body: "edited body" } });
    // GraphQL query should select body/url/user (verify the query string).
    expect(calls[0]?.query).toContain("body");
    expect(calls[0]?.query).toContain("url");
    expect(calls[0]?.query).toContain("user { id name email }");
  });

  it("handles null body/url/user gracefully (older Linear responses)", async () => {
    // Defensive: if Linear ever returns null for these new fields, the lib
    // shouldn't crash on the destructure.
    reset();
    mockRawResponses.push({
      data: {
        commentUpdate: {
          success: true,
          comment: {
            id: "c2",
            body: null,
            url: null,
            updatedAt: "2026-05-10T01:00:00Z",
            user: null,
          },
        },
      },
    });
    const result = await updateComment("c2", "x");
    expect(result.body).toBeNull();
    expect(result.url).toBeNull();
    expect(result.user).toBeNull();
  });
});

describe("deleteComment", () => {
  it("returns the success flag", async () => {
    reset();
    mockRawResponses.push({ data: { commentDelete: { success: true } } });
    expect(await deleteComment("c1")).toBe(true);
    mockRawResponses.push({ data: { commentDelete: { success: false } } });
    expect(await deleteComment("c2")).toBe(false);
  });
});
