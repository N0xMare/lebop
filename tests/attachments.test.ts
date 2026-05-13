import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../src/lib/errors.ts";

let mockRawResponses: Array<{ data: unknown }> = [];
let calls: Array<{ query: string; variables: unknown }> = [];

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
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
  }),
}));

import { deleteAttachment, listAttachments, updateAttachment } from "../src/lib/attachments.ts";

beforeEach(() => {
  mockRawResponses = [];
  calls = [];
});

describe("listAttachments", () => {
  it("shapes nodes from the issue.attachments connection", async () => {
    mockRawResponses.push({
      data: {
        issue: {
          attachments: {
            nodes: [
              {
                id: "att-1",
                title: "PR #42",
                url: "https://github.com/x/y/pull/42",
                sourceType: "github",
                metadata: { kind: "pr" },
                creator: { id: "u-1", name: "Alice", email: "a@x.io" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    const result = await listAttachments("NOX-1");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("att-1");
    expect(result[0]?.source_type).toBe("github");
    expect(result[0]?.creator?.email).toBe("a@x.io");
    expect(calls[0]?.variables).toMatchObject({ id: "NOX-1" });
  });

  it("throws NotFoundError when issue is missing", async () => {
    mockRawResponses.push({ data: { issue: null } });
    const err = await listAttachments("GHOST-99").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });
});

describe("updateAttachment", () => {
  it("sends only the fields that were provided and returns the shaped record", async () => {
    mockRawResponses.push({
      data: {
        attachmentUpdate: {
          success: true,
          attachment: {
            id: "att-1",
            title: "New title",
            url: "https://example.com",
            sourceType: null,
            metadata: null,
            creator: null,
          },
        },
      },
    });
    const a = await updateAttachment("att-1", { title: "New title" });
    expect(a.title).toBe("New title");
    expect((calls[0]?.variables as { input: { title?: string; url?: string } }).input).toEqual({
      title: "New title",
    });
  });
});

describe("deleteAttachment", () => {
  it("returns success boolean from the mutation", async () => {
    mockRawResponses.push({ data: { attachmentDelete: { success: true } } });
    const ok = await deleteAttachment("att-1");
    expect(ok).toBe(true);
  });
});
