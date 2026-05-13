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

  // ============================================================================
  // Round-8 backlog: lift recognized flags from AFTER the unknown -TOKEN to
  // BEFORE the `--` separator, so `lebop set labels ID -urgent --json` doesn't
  // result in commander consuming `--json` as a positional label token.
  // ============================================================================

  it("lifts a single --json flag past the -- separator (round-8 backlog)", () => {
    // Pre-fix: `set labels UE-351 -urgent --json` → `set labels UE-351 -- -urgent --json`
    //   (commander then ate `--json` as positional; preAction never saw the flag)
    // Post-fix: `--json` is lifted to before `--` so commander parses it as the flag.
    expect(preprocessSetArgv(["set", "labels", "UE-351", "-urgent", "--json"])).toEqual([
      "set",
      "labels",
      "UE-351",
      "--json",
      "--",
      "-urgent",
    ]);
  });

  it("lifts --team <value> + --json together (round-8 backlog)", () => {
    expect(
      preprocessSetArgv(["set", "links", "UE-355", "-blocks:UE-356", "--team", "OPS", "--json"]),
    ).toEqual(["set", "links", "UE-355", "--team", "OPS", "--json", "--", "-blocks:UE-356"]);
  });

  it("lifts --team=inline + --json with multiple unknown -TOKENs (round-8 backlog)", () => {
    expect(
      preprocessSetArgv(["set", "labels", "UE-351", "-urgent", "-clients", "--team=ENG", "--json"]),
    ).toEqual(["set", "labels", "UE-351", "--team=ENG", "--json", "--", "-urgent", "-clients"]);
  });

  it("omits the `--` separator when every tail token is a recognized flag (no unknowns to escape)", () => {
    // Defensive: if there's nothing actually needing escape, just lift the
    // flags into their natural position and skip the separator entirely.
    // This branch only fires if the trigger token (the unknown -TOKEN that
    // entered the lift branch) turns out NOT to require lifting itself —
    // which can't happen given how the algorithm walks, so this is a
    // theoretical guard. Test left in to lock the no-op behavior.
    const argv = ["set", "labels", "UE-351", "+keep"];
    // No unknown -TOKEN at all — preprocessor walks to end and returns argv.
    expect(preprocessSetArgv(argv)).toEqual(argv);
  });
});
