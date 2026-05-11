import { describe, expect, it } from "vitest";
import { expandIds } from "../src/lib/expand.ts";

describe("expandIds", () => {
  it("returns empty for no args", () => {
    expect(expandIds([])).toEqual([]);
  });

  it("uppercases single identifiers", () => {
    expect(expandIds(["ue-101"])).toEqual(["UE-101"]);
  });

  it("preserves order for a list", () => {
    expect(expandIds(["UE-3", "UE-1", "UE-2"])).toEqual(["UE-3", "UE-1", "UE-2"]);
  });

  it("expands an inclusive range", () => {
    expect(expandIds(["UE-5..UE-8"])).toEqual(["UE-5", "UE-6", "UE-7", "UE-8"]);
  });

  it("expands a reversed range as ascending", () => {
    expect(expandIds(["UE-8..UE-5"])).toEqual(["UE-5", "UE-6", "UE-7", "UE-8"]);
  });

  it("deduplicates across list + range overlap", () => {
    expect(expandIds(["UE-5", "UE-4..UE-6"])).toEqual(["UE-5", "UE-4", "UE-6"]);
  });

  it("normalizes case inside a range", () => {
    expect(expandIds(["ue-1..ue-3"])).toEqual(["UE-1", "UE-2", "UE-3"]);
  });

  it("throws on mismatched team prefixes", () => {
    expect(() => expandIds(["UE-1..XY-3"])).toThrow(/prefixes must match/);
  });

  it("throws on malformed range", () => {
    expect(() => expandIds(["UE-1..nonsense"])).toThrow(/range must be of form/);
  });

  it("throws on incomplete range", () => {
    expect(() => expandIds(["UE-1.."])).toThrow(/invalid range|range must be of form/);
  });
});
