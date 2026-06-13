import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";

let mockResponse: unknown = null;
let mockResponses: unknown[] = [];
let lastCall: { query: string; variables: unknown } | null = null;

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          lastCall = { query, variables };
          return mockResponses.length > 0 ? mockResponses.shift() : mockResponse;
        },
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: async (query: string, variables: unknown) => {
        lastCall = { query, variables };
        return mockResponses.length > 0 ? mockResponses.shift() : mockResponse;
      },
    },
  }),
}));

import {
  assertRelationCreateConfirmed,
  deleteLink,
  findLink,
  LINK_KINDS,
  listRelations,
  listRelationsPage,
  parseLinkToken,
  preflightCreateLink,
} from "../src/lib/relations.ts";

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

  it("accepts digit-bearing team keys", () => {
    expect(parseLinkToken("+blocks:a1-42").target).toBe("A1-42");
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

  it("related deletion lookup matches inbound related edges", async () => {
    mockResponse = {
      data: {
        issue: {
          relations: { nodes: [] },
          inverseRelations: {
            nodes: [
              {
                id: "rel-related-inbound",
                type: "related",
                issue: { id: "uuid-target", identifier: "NOX-303" },
              },
            ],
          },
        },
      },
    };

    await expect(findLink("NOX-1", "nox-303", "related")).resolves.toBe("rel-related-inbound");
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

  it("walks relation pages before declaring a link absent", async () => {
    mockResponses = [
      {
        data: {
          issue: {
            relations: {
              nodes: [{ id: "rel-other", type: "blocks", relatedIssue: { identifier: "NOX-100" } }],
              pageInfo: { hasNextPage: true, endCursor: "outbound-cursor-1" },
            },
            inverseRelations: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        data: {
          issue: {
            relations: {
              nodes: [
                { id: "rel-target", type: "blocks", relatedIssue: { identifier: "NOX-101" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            inverseRelations: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ];

    await expect(findLink("NOX-1", "NOX-101", "blocks")).resolves.toBe("rel-target");
    expect(lastCall).toMatchObject({
      variables: expect.objectContaining({ outboundAfter: "outbound-cursor-1" }),
    });
    mockResponses = [];
  });
});

describe("relation create preflight", () => {
  it("does not require confirmation for an exact existing relation", async () => {
    mockResponse = {
      data: {
        issue: {
          relations: {
            nodes: [{ id: "rel-existing", type: "blocks", relatedIssue: { identifier: "NOX-2" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          inverseRelations: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };

    const preflight = await preflightCreateLink("NOX-1", "NOX-2", "blocks");

    expect(preflight.exact?.id).toBe("rel-existing");
    expect(preflight.needsConfirmation).toBe(false);
    expect(() => assertRelationCreateConfirmed(preflight, false)).not.toThrow();
  });

  it("requires confirmation when a different same-pair relation would be replaced", async () => {
    mockResponse = {
      data: {
        issue: {
          relations: {
            nodes: [{ id: "rel-related", type: "related", relatedIssue: { identifier: "NOX-2" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          inverseRelations: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };

    const preflight = await preflightCreateLink("NOX-1", "NOX-2", "blocks");

    expect(preflight.wouldReplace).toBe(true);
    expect(preflight.needsConfirmation).toBe(true);
    expect(() => assertRelationCreateConfirmed(preflight, false)).toThrow(/requires confirmation/);
    expect(() => assertRelationCreateConfirmed(preflight, true)).not.toThrow();
  });

  it("requires confirmation for new duplicate relations because Linear can move issue state", async () => {
    mockResponse = {
      data: {
        issue: {
          relations: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          inverseRelations: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };

    const preflight = await preflightCreateLink("NOX-1", "NOX-2", "duplicates");

    expect(preflight.duplicateSideEffect).toBe(true);
    expect(preflight.needsConfirmation).toBe(true);
    expect(() => assertRelationCreateConfirmed(preflight, false)).toThrow(/requires confirmation/);
  });
});

describe("listRelations", () => {
  it("rejects repeated outbound cursors while walking relation pages", async () => {
    mockResponses = [
      {
        data: {
          issue: {
            relations: {
              nodes: [{ id: "rel-1", type: "blocks", relatedIssue: { identifier: "NOX-2" } }],
              pageInfo: { hasNextPage: true, endCursor: "outbound-cursor-1" },
            },
            inverseRelations: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        data: {
          issue: {
            relations: {
              nodes: [{ id: "rel-2", type: "blocks", relatedIssue: { identifier: "NOX-3" } }],
              pageInfo: { hasNextPage: true, endCursor: "outbound-cursor-1" },
            },
          },
        },
      },
    ];

    await expect(listRelations("NOX-1")).rejects.toThrow(/outbound cursor did not advance/);
    expect(lastCall?.variables).toMatchObject({
      outboundAfter: "outbound-cursor-1",
      includeOutbound: true,
      includeInbound: false,
    });
    mockResponses = [];
  });
});

describe("deleteLink", () => {
  it("throws when Linear returns success:false", async () => {
    mockResponse = { data: { issueRelationDelete: { success: false } } };

    await expect(deleteLink("relation-1")).rejects.toThrow("issueRelationDelete failed");
    expect(lastCall).toMatchObject({
      variables: { id: "relation-1" },
    });
  });
});

describe("listRelationsPage", () => {
  it("returns outbound and inbound relation page cursors", async () => {
    mockResponse = {
      data: {
        issue: {
          relations: {
            nodes: [{ id: "rel-out", type: "blocks", relatedIssue: { identifier: "NOX-2" } }],
            pageInfo: { hasNextPage: true, endCursor: "outbound-cursor-1" },
          },
          inverseRelations: {
            nodes: [{ id: "rel-in", type: "related", issue: { identifier: "NOX-3" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };

    const page = await listRelationsPage("NOX-1", {
      first: 1,
      outboundAfter: "outbound-prior",
      inboundAfter: "inbound-prior",
    });

    expect(page.outbound).toEqual([{ id: "rel-out", type: "blocks", otherIdentifier: "NOX-2" }]);
    expect(page.inbound).toEqual([{ id: "rel-in", type: "related", otherIdentifier: "NOX-3" }]);
    expect(page.complete).toBe(false);
    expect(page.pageInfo.outbound).toEqual({
      hasNextPage: true,
      endCursor: "outbound-cursor-1",
    });
    expect(lastCall?.variables).toMatchObject({
      id: "NOX-1",
      first: 1,
      outboundAfter: "outbound-prior",
      inboundAfter: "inbound-prior",
    });
  });
});
