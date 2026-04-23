import { describe, expect, it } from "vitest";
import { LINK_KINDS, parseLinkToken } from "../src/lib/relations.ts";

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

  it("rejects tokens without colon", () => {
    expect(() => parseLinkToken("+blocksUE-1")).toThrow(/KIND:TARGET/);
  });

  it("rejects unknown kinds with suggestion list", () => {
    expect(() => parseLinkToken("+similar:UE-1")).toThrow(/unknown link kind "similar"/);
    expect(() => parseLinkToken("+similar:UE-1")).toThrow(/similar lives in `leebop raw`/);
  });

  it("rejects invalid target identifiers", () => {
    expect(() => parseLinkToken("+blocks:garbage")).toThrow(/invalid target identifier/);
    expect(() => parseLinkToken("+blocks:UE")).toThrow(/invalid target identifier/);
    expect(() => parseLinkToken("+blocks:UE-")).toThrow(/invalid target identifier/);
  });

  it("exposes the full kind list", () => {
    expect(LINK_KINDS).toEqual(["blocks", "blocked-by", "duplicates", "duplicated-by", "related"]);
  });
});
