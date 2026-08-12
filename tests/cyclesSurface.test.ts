import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import {
  buildCycleArchiveInputFromCli,
  buildCycleCreateInputFromCli,
  buildCycleCreateInputFromMcp,
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

  it("create requires starts/ends and validates ISO DateTime", () => {
    expect(() => buildCycleCreateInputFromCli({ opts: {} })).toThrow(ValidationError);
    expect(() =>
      buildCycleCreateInputFromCli({
        opts: { starts: "not-a-date", ends: "2026-09-14T00:00:00.000Z" },
      }),
    ).toThrow(/ISO DateTime|must be a valid/);

    const created = buildCycleCreateInputFromCli({
      opts: {
        team: "TEAM",
        starts: "2026-09-01T00:00:00.000Z",
        ends: "2026-09-14T23:59:59.999Z",
        name: "Far Future",
        description: "lebop pass2",
      },
    });
    expect(created).toEqual({
      team: "TEAM",
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2026-09-14T23:59:59.999Z",
      name: "Far Future",
      description: "lebop pass2",
    });

    const mcp = buildCycleCreateInputFromMcp({
      starts_at: "2026-09-01T00:00:00.000Z",
      ends_at: "2026-09-14T23:59:59.999Z",
    });
    expect(mcp.startsAt).toBe("2026-09-01T00:00:00.000Z");
    expect(mcp.endsAt).toBe("2026-09-14T23:59:59.999Z");
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
