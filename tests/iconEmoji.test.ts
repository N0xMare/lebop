/**
 * Wave-2 / item #8 — `icon` params accept Linear's internal icon names only
 * (PascalCase like 'BarChart'). Passing an emoji silently round-trips as a
 * non-functional string; the lib now rejects up-front with a structured
 * ValidationError so callers get an actionable message instead of an opaque
 * server-side rejection.
 *
 * Coverage: createDocument, updateDocument, createInitiative, updateInitiative.
 */

import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";

// Stub the SDK so we never make a real network call — the lib should throw
// the ValidationError before reaching the SDK.
const rawRequestSpy = vi.fn();
vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: { rawRequest: rawRequestSpy },
    }),
  linear: async () => ({
    client: { rawRequest: rawRequestSpy },
  }),
}));

import { createDocument, updateDocument } from "../src/lib/documents.ts";
import { createInitiative, updateInitiative } from "../src/lib/initiatives.ts";

const EMOJI_SAMPLES = ["🚀", "📊", "🎯", "✨"];

describe("createDocument icon validation", () => {
  for (const sample of EMOJI_SAMPLES) {
    it(`rejects emoji icon ${sample}`, async () => {
      await expect(
        createDocument({ title: "x", projectId: "proj-1", icon: sample }),
      ).rejects.toThrow(ValidationError);
      expect(rawRequestSpy).not.toHaveBeenCalled();
    });
  }

  it("rejects emoji with code 'validation_error'", async () => {
    try {
      await createDocument({ title: "x", projectId: "proj-1", icon: "🚀" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("validation_error");
      expect((err as ValidationError).hint).toContain("BarChart");
    }
  });
});

describe("updateDocument icon validation", () => {
  it("rejects emoji icon", async () => {
    await expect(updateDocument("doc-1", { icon: "🎯" })).rejects.toThrow(ValidationError);
  });

  it("passes through undefined icon (no rejection)", async () => {
    // No icon → no check → the SDK mock should be called and we shape the
    // returned record from a stubbed response.
    rawRequestSpy.mockResolvedValueOnce({
      data: {
        documentUpdate: {
          success: true,
          document: {
            id: "doc-1",
            title: "t",
            slugId: "s",
            icon: null,
            url: "https://linear.app/x/doc/1",
            content: null,
            archivedAt: null,
            project: null,
            creator: null,
          },
        },
      },
    });
    const result = await updateDocument("doc-1", { title: "new title" });
    expect(result.id).toBe("doc-1");
  });
});

describe("createInitiative icon validation", () => {
  for (const sample of EMOJI_SAMPLES) {
    it(`rejects emoji icon ${sample}`, async () => {
      await expect(createInitiative({ name: "x", icon: sample })).rejects.toThrow(ValidationError);
    });
  }
});

describe("updateInitiative icon validation", () => {
  it("rejects emoji icon", async () => {
    await expect(updateInitiative("init-1", { icon: "📊" })).rejects.toThrow(ValidationError);
  });
});
