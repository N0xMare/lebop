import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import {
  buildCycleArchiveInputFromCli,
  buildCycleListInputFromCli,
  buildCycleListInputFromMcp,
  buildCycleUpdateInputFromCli,
  buildCycleUpdateInputFromMcp,
} from "../src/surface/cycles.ts";

describe("cycles surface builders", () => {
  it("list accepts include_archived and maps limit 0 to Infinity", () => {
    const cli = buildCycleListInputFromCli({
      opts: { includeArchived: true, limit: "0", allTeams: true },
    });
    expect(cli).toMatchObject({
      allTeams: true,
      includeArchived: true,
      max: Number.POSITIVE_INFINITY,
    });

    const mcp = buildCycleListInputFromMcp({
      include_archived: true,
      all_teams: true,
      limit: 0,
    });
    expect(mcp).toMatchObject({
      allTeams: true,
      includeArchived: true,
      max: Number.POSITIVE_INFINITY,
    });
  });

  it("update rejects empty patch and maps CLI null sentinels", () => {
    expect(() => buildCycleUpdateInputFromCli({ id: "c1", opts: {} })).toThrow(ValidationError);

    const updated = buildCycleUpdateInputFromCli({
      id: "c1",
      opts: {
        description: "null",
        completedAt: "null",
        name: "Renamed",
      },
    });
    expect(updated).toEqual({
      id: "c1",
      name: "Renamed",
      description: null,
      completedAt: null,
    });

    const mcp = buildCycleUpdateInputFromMcp({
      id: "c1",
      completed_at: "2026-09-10T12:00:00.000Z",
    });
    expect(mcp.completedAt).toBe("2026-09-10T12:00:00.000Z");
  });

  it("archive requires --yes on CLI", () => {
    expect(() => buildCycleArchiveInputFromCli({ id: "c1", opts: {} })).toThrow(/--yes/);
    expect(buildCycleArchiveInputFromCli({ id: "c1", opts: { yes: true } })).toEqual({
      id: "c1",
    });
  });
});
