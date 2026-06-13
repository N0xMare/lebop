import { describe, expect, it } from "vitest";
import { parseCliLimit, parseCliNumber } from "../src/lib/cliOptions.ts";

describe("parseCliLimit", () => {
  it("parses default and explicit positive integer limits", () => {
    expect(parseCliLimit(undefined, { defaultValue: 50 })).toBe(50);
    expect(parseCliLimit("25")).toBe(25);
    expect(parseCliLimit("001")).toBe(1);
  });

  it("preserves --limit 0 as infinity only for commands that opt in", () => {
    expect(parseCliLimit("0", { zeroMeansInfinity: true })).toBe(Number.POSITIVE_INFINITY);
    expect(() => parseCliLimit("0")).toThrow(/invalid --limit value "0"/);
  });

  it.each([
    "1abc",
    "3.7",
    "-1",
    "Infinity",
    "",
    "9007199254740993",
  ])("rejects non-strict limit value %s", (value) => {
    expect(() => parseCliLimit(value, { zeroMeansInfinity: true })).toThrow(
      new RegExp(`invalid --limit value "${value}"`),
    );
  });

  it("enforces bounded workspace limits", () => {
    expect(parseCliLimit("250", { max: 250 })).toBe(250);
    expect(() => parseCliLimit("251", { max: 250 })).toThrow(/invalid --limit value "251"/);
  });
});

describe("parseCliNumber", () => {
  it("accepts strict finite numeric strings", () => {
    expect(parseCliNumber("1", { optionName: "--estimate" })).toBe(1);
    expect(parseCliNumber("0.5", { optionName: "--estimate" })).toBe(0.5);
    expect(parseCliNumber("-2", { optionName: "--sort-order", allowNegative: true })).toBe(-2);
  });

  it.each(["1abc", "Infinity", "NaN", "", "--1"])("rejects malformed number %s", (value) => {
    expect(() => parseCliNumber(value, { optionName: "--estimate" })).toThrow(
      new RegExp(`invalid --estimate value "${value}"`),
    );
  });

  it("rejects negative values unless the caller opts in", () => {
    expect(() => parseCliNumber("-1", { optionName: "--estimate" })).toThrow(
      /invalid --estimate value "-1"/,
    );
  });
});
