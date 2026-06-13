import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";

let mockRawResponses: Array<{ data: unknown }> = [];

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: {
        rawRequest: async () => {
          const next = mockRawResponses.shift();
          if (!next) throw new Error("mock exhausted");
          return next;
        },
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: async () => {
        const next = mockRawResponses.shift();
        if (!next) throw new Error("mock exhausted");
        return next;
      },
    },
  }),
}));

import { createDocument, deleteDocument, updateDocument } from "../src/lib/documents.ts";

beforeEach(() => {
  mockRawResponses = [];
});

describe("document mutation truthfulness", () => {
  it("createDocument returns a stable project-scoped issue:null shape", async () => {
    mockRawResponses.push({
      data: { documentCreate: { success: true, document: documentNode() } },
    });

    const doc = await createDocument({ title: "Doc", projectId: "proj-1" });

    expect(doc).toMatchObject({
      id: "doc-1",
      project: { id: "proj-1", name: "Project" },
      issue: null,
    });
  });

  it("createDocument rejects success:false before shaping the document", async () => {
    mockRawResponses.push({
      data: { documentCreate: { success: false, document: documentNode() } },
    });

    const err = await createDocument({ title: "Doc", projectId: "proj-1" }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("documentCreate failed");
  });

  it("updateDocument returns a stable project-scoped issue:null shape", async () => {
    mockRawResponses.push({
      data: { documentUpdate: { success: true, document: documentNode() } },
    });

    const doc = await updateDocument("doc-1", { title: "Doc v2" });

    expect(doc).toMatchObject({
      id: "doc-1",
      project: { id: "proj-1", name: "Project" },
      issue: null,
    });
  });

  it("updateDocument rejects success:false before shaping the document", async () => {
    mockRawResponses.push({
      data: { documentUpdate: { success: false, document: documentNode() } },
    });

    const err = await updateDocument("doc-1", { title: "Doc v2" }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("documentUpdate failed");
  });

  it("deleteDocument rejects success:false after the live preflight", async () => {
    mockRawResponses.push({ data: { document: documentNode() } });
    mockRawResponses.push({ data: { documentDelete: { success: false } } });

    const err = await deleteDocument("doc-1").catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("documentDelete failed");
  });
});

function documentNode() {
  return {
    id: "doc-1",
    title: "Doc",
    slugId: "doc",
    icon: null,
    url: "https://linear.app/test/doc/doc",
    content: "body",
    archivedAt: null,
    project: { id: "proj-1", name: "Project" },
    issue: null,
    creator: null,
  };
}
