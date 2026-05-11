import { describe, expect, it } from "vitest";
import { preprocessSetArgv } from "../src/lib/argvPrep.ts";

describe("preprocessSetArgv", () => {
  it("leaves non-set argv alone", () => {
    const argv = ["pull", "UE-101"];
    expect(preprocessSetArgv(argv)).toBe(argv);
  });

  it("leaves empty argv alone", () => {
    expect(preprocessSetArgv([])).toEqual([]);
  });

  it("inserts -- before a leading - delta in set labels", () => {
    expect(preprocessSetArgv(["set", "labels", "UE-351", "-type:test"])).toEqual([
      "set",
      "labels",
      "UE-351",
      "--",
      "-type:test",
    ]);
  });

  it("inserts -- before a leading - delta in set links", () => {
    expect(preprocessSetArgv(["set", "links", "UE-355", "-blocks:UE-356"])).toEqual([
      "set",
      "links",
      "UE-355",
      "--",
      "-blocks:UE-356",
    ]);
  });

  it("skips --json flag before the delta", () => {
    expect(preprocessSetArgv(["set", "labels", "UE-351", "--json", "-type:test"])).toEqual([
      "set",
      "labels",
      "UE-351",
      "--json",
      "--",
      "-type:test",
    ]);
  });

  it("skips --team <value> before positionals", () => {
    expect(preprocessSetArgv(["set", "labels", "--team", "UE", "UE-351", "-type:test"])).toEqual([
      "set",
      "labels",
      "--team",
      "UE",
      "UE-351",
      "--",
      "-type:test",
    ]);
  });

  it("skips --team=inline before positionals", () => {
    expect(preprocessSetArgv(["set", "labels", "--team=UE", "UE-351", "-type:test"])).toEqual([
      "set",
      "labels",
      "--team=UE",
      "UE-351",
      "--",
      "-type:test",
    ]);
  });

  it("does nothing when + delta comes first (commander accepts +)", () => {
    const argv = ["set", "labels", "UE-351", "+type:test", "-priority:p0"];
    expect(preprocessSetArgv(argv)).toEqual([
      "set",
      "labels",
      "UE-351",
      "+type:test",
      "--",
      "-priority:p0",
    ]);
  });

  it("leaves argv alone when -- is already present", () => {
    const argv = ["set", "labels", "UE-351", "--", "-type:test"];
    expect(preprocessSetArgv(argv)).toBe(argv);
  });

  it("leaves argv alone when unknown option appears before positionals", () => {
    const argv = ["set", "--bogus", "labels", "UE-351"];
    expect(preprocessSetArgv(argv)).toBe(argv);
  });

  it("handles only one positional (no insertion — not our case)", () => {
    const argv = ["set", "labels"];
    expect(preprocessSetArgv(argv)).toEqual(["set", "labels"]);
  });

  it("doesn't insert when no dash delta follows the positionals", () => {
    const argv = ["set", "labels", "UE-351", "+type:test"];
    expect(preprocessSetArgv(argv)).toEqual(["set", "labels", "UE-351", "+type:test"]);
  });

  it("inserts before the first unknown -X when multiple are present", () => {
    expect(
      preprocessSetArgv(["set", "links", "UE-355", "-blocks:UE-356", "-related:UE-356"]),
    ).toEqual(["set", "links", "UE-355", "--", "-blocks:UE-356", "-related:UE-356"]);
  });

  it("handles mixed +/- tokens with -- inserted before the first -", () => {
    expect(preprocessSetArgv(["set", "labels", "UE-351", "+foo", "-bar", "+baz"])).toEqual([
      "set",
      "labels",
      "UE-351",
      "+foo",
      "--",
      "-bar",
      "+baz",
    ]);
  });
});
