import { describe, expect, it, vi } from "vitest";

// Mock the Linear client BEFORE importing the lib functions under test.
let mockRawResponses: Array<{ data: unknown }> = [];
let mockCreateCommentResult: {
  success: boolean;
  comment: { id: string; createdAt: Date | string };
} | null = null;
let calls: Array<{ query: string; variables: unknown }> = [];
let createCommentArgs: Array<unknown> = [];

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      // `withClient(c => c.issue(...))` is used by addComment to resolve the
      // identifier → UUID; return a stub issue.
      issue: async (_id: string) => ({ id: "issue-uuid-123" }),
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

  it("rejects when createComment.success is false", async () => {
    reset();
    mockCreateCommentResult = { success: false, comment: { id: "x", createdAt: "x" } };
    await expect(addComment({ identifier: "NOX-1", body: "x" })).rejects.toThrow(/Linear rejected/);
  });
});

describe("updateComment", () => {
  it("calls commentUpdate with id + input.body", async () => {
    reset();
    mockRawResponses.push({
      data: {
        commentUpdate: {
          success: true,
          comment: { id: "c1", updatedAt: "2026-05-10T01:00:00Z" },
        },
      },
    });
    const result = await updateComment("c1", "edited body");
    expect(result).toEqual({ id: "c1", updated_at: "2026-05-10T01:00:00Z" });
    expect(calls[0]?.variables).toEqual({ id: "c1", input: { body: "edited body" } });
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
