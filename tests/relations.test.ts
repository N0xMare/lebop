import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";

let mockResponse: unknown = null;
let lastCall: { query: string; variables: unknown } | null = null;

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          lastCall = { query, variables };
          return mockResponse;
        },
      },
    }),
  linear: async () => ({ client: { rawRequest: async () => mockResponse } }),
}));

import { findLink, LINK_KINDS, parseLinkToken } from "../src/lib/relations.ts";

describe("parseLinkToken", () => {
  it("parses +blocks:UE-101", () => {
    expect(parseLinkToken("+blocks:UE-101")).toEqual({
      op: "+",
      kind: "blocks",
      target: "UE-101",
    });
  });

  it("parses -related:UE-7", () => {
    expect(parseLinkToken("-related:UE-7")).toEqual({
      op: "-",
      kind: "related",
      target: "UE-7",
    });
  });

  it("parses +blocked-by:UE-42", () => {
    expect(parseLinkToken("+blocked-by:UE-42")).toEqual({
      op: "+",
      kind: "blocked-by",
      target: "UE-42",
    });
  });

  it("parses +duplicates:UE-1", () => {
    expect(parseLinkToken("+duplicates:UE-1").kind).toBe("duplicates");
  });

  it("parses +duplicated-by:UE-1", () => {
    expect(parseLinkToken("+duplicated-by:UE-1").kind).toBe("duplicated-by");
  });

  it("uppercases lowercase identifiers", () => {
    expect(parseLinkToken("+blocks:ue-101").target).toBe("UE-101");
  });

  it("rejects tokens without +/-", () => {
    expect(() => parseLinkToken("blocks:UE-1")).toThrow(/must start with \+ or -/);
  });

  // Round-7 / HIGH-4: lock the flag-shaped detection. A misplaced
  // commander flag (`--team`, `--json`) reaching parseLinkToken as a
  // positional should emit the dedicated "use `--` separator" hint, not
  // the generic "must be of form" message.
  it("rejects `--team` flag-shaped tokens with a tailored hint", () => {
    const err = (() => {
      try {
        parseLinkToken("--team");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toMatch(/looks like a CLI flag/);
    expect((err as ValidationError).hint).toMatch(/--.*to split|BEFORE positional/);
  });

  it("rejects `--json` flag-shaped tokens", () => {
    expect(() => parseLinkToken("--json")).toThrow(/looks like a CLI flag/);
  });

  it("accepts genuine `-KIND:TARGET` removals (negative-prefix is NOT a flag)", () => {
    // Regression: round-6 had a dead second clause that would have
    // matched `-blocks:NOX-1`. Round-7 dropped it. Verify `-blocks:NOX-1`
    // still parses as a removal delta.
    expect(parseLinkToken("-blocks:NOX-1")).toEqual({
      op: "-",
      kind: "blocks",
      target: "NOX-1",
    });
  });

  it("rejects tokens without colon", () => {
    expect(() => parseLinkToken("+blocksUE-1")).toThrow(/KIND:TARGET/);
  });

  it("rejects unknown kinds with suggestion list", () => {
    expect(() => parseLinkToken("+similar:UE-1")).toThrow(/unknown link kind "similar"/);
    expect(() => parseLinkToken("+similar:UE-1")).toThrow(/similar lives in `lebop raw`/);
  });

  it("rejects invalid target identifiers", () => {
    expect(() => parseLinkToken("+blocks:garbage")).toThrow(/invalid target identifier/);
    expect(() => parseLinkToken("+blocks:UE")).toThrow(/invalid target identifier/);
    expect(() => parseLinkToken("+blocks:UE-")).toThrow(/invalid target identifier/);
  });

  it("exposes the full kind list", () => {
    expect(LINK_KINDS).toEqual(["blocks", "blocked-by", "duplicates", "duplicated-by", "related"]);
  });

  // Wave 3 / structured-error taxonomy: every parse failure must surface as
  // a ValidationError with code + hint, not a raw Error.
  it("missing operator error is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        parseLinkToken("blocks:UE-1");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: "validation_error",
      hint: expect.any(String),
    });
  });

  it("missing colon error is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        parseLinkToken("+blocksUE-1");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: "validation_error",
      hint: expect.any(String),
    });
  });

  it("unknown kind error is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        parseLinkToken("+similar:UE-1");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: "validation_error",
      hint: expect.any(String),
    });
  });

  it("invalid target error is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        parseLinkToken("+blocks:garbage");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: "validation_error",
      hint: expect.any(String),
    });
  });
});

describe("findLink — round-6 / H4 case-folding regression coverage", () => {
  // Round 5 added defensive `.toUpperCase()` on the identifier comparison
  // in both forward and inverse relation branches (src/lib/relations.ts:139
  // + :144 at the time). Pattern hardens against future call sites that
  // skip normalization or Linear alias-resolution surfacing lowercase
  // identifiers. Without this guard, the function would silently return
  // null when the stored vs. target identifier differ only in case — agents
  // would think the relation doesn't exist and create a duplicate.

  it("forward branch matches when stored identifier is uppercase and target is lowercase", async () => {
    mockResponse = {
      data: {
        issue: {
          relations: {
            nodes: [
              {
                id: "rel-fwd-1",
                type: "blocks",
                relatedIssue: { id: "uuid-target", identifier: "NOX-101" },
              },
            ],
          },
          inverseRelations: { nodes: [] },
        },
      },
    };
    // Target is lowercase — pre-guard this would miss the match. Post-guard
    // both sides normalize to NOX-101 and we get the relation id.
    const id = await findLink("NOX-1", "nox-101", "blocks");
    expect(id).toBe("rel-fwd-1");
  });

  it("forward branch matches when stored identifier is lowercase (hypothetical alias-drift)", async () => {
    // Defensive: Linear could one day return lowercase via an alias-redirect.
    // The .toUpperCase() guard handles that direction too.
    mockResponse = {
      data: {
        issue: {
          relations: {
            nodes: [
              {
                id: "rel-fwd-2",
                type: "blocks",
                relatedIssue: { id: "uuid-target", identifier: "nox-101" },
              },
            ],
          },
          inverseRelations: { nodes: [] },
        },
      },
    };
    const id = await findLink("NOX-1", "NOX-101", "blocks");
    expect(id).toBe("rel-fwd-2");
  });

  it("inverse branch matches when stored identifier and target differ in case", async () => {
    // `blocked-by` triggers the inverse branch. Same case-folding guard
    // applies symmetrically — round-5 patched both branches at once.
    mockResponse = {
      data: {
        issue: {
          relations: { nodes: [] },
          inverseRelations: {
            nodes: [
              {
                id: "rel-inv-1",
                type: "blocks",
                issue: { id: "uuid-target", identifier: "NOX-202" },
              },
            ],
          },
        },
      },
    };
    const id = await findLink("NOX-1", "nox-202", "blocked-by");
    expect(id).toBe("rel-inv-1");
  });

  it("returns null when no relation matches (regardless of case)", async () => {
    mockResponse = {
      data: {
        issue: {
          relations: { nodes: [] },
          inverseRelations: { nodes: [] },
        },
      },
    };
    expect(await findLink("NOX-1", "nox-999", "blocks")).toBeNull();
  });

  it("returns null when issue itself is null (resolver miss)", async () => {
    mockResponse = { data: { issue: null } };
    expect(await findLink("NOX-1", "NOX-101", "blocks")).toBeNull();
  });

  it("preserves the FIND_QUERY shape (passes selfIdentifier as `id`)", async () => {
    mockResponse = {
      data: { issue: { relations: { nodes: [] }, inverseRelations: { nodes: [] } } },
    };
    lastCall = null;
    await findLink("NOX-1", "NOX-101", "blocks");
    expect((lastCall as { variables: { id: string } } | null)?.variables.id).toBe("NOX-1");
  });
});
