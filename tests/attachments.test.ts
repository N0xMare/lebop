import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, ValidationError } from "../src/lib/errors.ts";

let mockRawResponses: Array<{ data: unknown }> = [];
let calls: Array<{ source: "withClient" | "linear"; query: string; variables: unknown }> = [];

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      issue: async (id: string) => ({ id: `uuid-of-${id}` }),
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          calls.push({ source: "withClient", query, variables });
          const next = mockRawResponses.shift();
          if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
          return next;
        },
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: async (query: string, variables: unknown) => {
        calls.push({ source: "linear", query, variables });
        const next = mockRawResponses.shift();
        if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
        return next;
      },
    },
  }),
}));

import {
  deleteAttachment,
  linkUrlAttachment,
  listAttachments,
  listAttachmentsPage,
  updateAttachment,
} from "../src/lib/attachments.ts";

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

  it("returns one attachment page with Linear cursor metadata", async () => {
    mockRawResponses.push({
      data: {
        issue: {
          attachments: {
            nodes: [
              {
                id: "att-1",
                title: "Spec",
                url: "https://example.test/spec",
                sourceType: null,
                metadata: null,
                creator: null,
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "attachment-cursor-1" },
          },
        },
      },
    });

    const page = await listAttachmentsPage("NOX-1", { first: 1, after: "prior-cursor" });

    expect(page.attachments).toHaveLength(1);
    expect(page.pageInfo).toEqual({ hasNextPage: true, endCursor: "attachment-cursor-1" });
    expect(calls[0]?.variables).toMatchObject({
      id: "NOX-1",
      first: 1,
      after: "prior-cursor",
    });
  });
});

describe("linkUrlAttachment", () => {
  it("rejects success:false before shaping the linked attachment", async () => {
    mockRawResponses.push({
      data: {
        attachmentLinkURL: {
          success: false,
          attachment: {
            id: "att-1",
            title: "Spec",
            url: "https://example.test/spec",
          },
        },
      },
    });

    const err = await linkUrlAttachment("NOX-1", "https://example.test/spec", "Spec").catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("attachmentLinkURL failed");
    expect(calls[0]?.variables).toMatchObject({
      issueId: "uuid-of-NOX-1",
      url: "https://example.test/spec",
      title: "Spec",
    });
    expect(calls[0]?.source).toBe("linear");
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

  it("rejects URL updates before sending invalid GraphQL", async () => {
    const err = await updateAttachment("att-1", { url: "https://example.com/new" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/URL cannot be updated/);
    expect(calls).toHaveLength(0);
  });

  it("rejects success:false before shaping the attachment", async () => {
    mockRawResponses.push({
      data: {
        attachmentUpdate: {
          success: false,
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

    const err = await updateAttachment("att-1", { title: "New title" }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("attachmentUpdate failed");
  });
});

describe("deleteAttachment", () => {
  it("returns success boolean from the mutation", async () => {
    mockRawResponses.push({ data: { attachmentDelete: { success: true } } });
    const ok = await deleteAttachment("att-1");
    expect(ok).toBe(true);
  });

  it("rejects success:false", async () => {
    mockRawResponses.push({ data: { attachmentDelete: { success: false } } });

    const err = await deleteAttachment("att-1").catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("attachmentDelete failed");
  });
});
